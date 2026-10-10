#!/usr/bin/env python3
"""Trusted WRET guest agent. Requires distro python3-websocket and Chromium."""
import base64
import concurrent.futures
import http.server
import json
import io
import mimetypes
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
import websocket

test_stdio = os.environ.get('WRET_AGENT_TEST_STDIO') == '1'
control = sys.stdout.buffer if test_stdio else open('/dev/virtio-ports/org.wret.control', 'r+b', buffering=0)
control_reader = sys.stdin.buffer if test_stdio else io.BufferedReader(control, buffer_size=65536)
write_lock = threading.Lock()
pending_host = {}
pending_cdp = {}
pending_lock = threading.Lock()
executor = concurrent.futures.ThreadPoolExecutor(max_workers=12)
command_executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)
files = {}
targets = {}
breakpoints = {}
script_urls = {}
network_contexts = {}
pause_exceptions = 'none'
skip_pauses = False
live_edit_supported = False
cdp = None
main_session = None
root_prefix = ''
counter = 0
counter_lock = threading.Lock()

def send(message):
    encoded = (json.dumps(message, separators=(',', ':')) + '\n').encode()
    with write_lock:
        view = memoryview(encoded)
        while view:
            view = view[control.write(view):]
        if test_stdio:
            control.flush()

def observe(kind, data):
    send({'kind': kind, 'data': data})

def host_request(data):
    ident = str(uuid.uuid4())
    result = queue.Queue(maxsize=1)
    with pending_lock:
        pending_host[ident] = result
    send({'id': ident, 'kind': 'broker', 'data': data})
    try:
        message = result.get(timeout=20)
        if 'error' in message:
            raise RuntimeError(message['error'])
        return message['result']
    finally:
        with pending_lock:
            pending_host.pop(ident, None)

def call(method, params=None, session=None):
    global counter
    with counter_lock:
        counter += 1
        ident = counter
    result = queue.Queue(maxsize=1)
    with pending_lock:
        pending_cdp[ident] = result
    payload = {'id': ident, 'method': method, 'params': params or {}}
    if session:
        payload['sessionId'] = session
    cdp.send(json.dumps(payload))
    try:
        message = result.get(timeout=15)
        if 'error' in message:
            raise RuntimeError(str(message['error']))
        return message.get('result', {})
    finally:
        with pending_lock:
            pending_cdp.pop(ident, None)

def initialize(session, info):
    targets[session] = info
    for method in ['Runtime.enable', 'Debugger.enable', 'Network.enable']:
        call(method, session=session)
    call('Debugger.setPauseOnExceptions', {'state': pause_exceptions}, session)
    call('Debugger.setSkipAllPauses', {'skip': skip_pauses}, session)
    call('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': True, 'flatten': True}, session)
    try:
        call('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]}, session)
    except Exception as error:
        observe('diagnostic', 'Request interception unavailable on target: ' + str(error))
    for bp in list(breakpoints.values()):
        set_breakpoint(session, bp['definition'])
    if info.get('type') in ['page', 'iframe']:
        call('Page.enable', session=session)
        if info.get('type') == 'page':
            call('Emulation.setDeviceMetricsOverride', {'width': 1280, 'height': 720, 'deviceScaleFactor': 1, 'mobile': False}, session)
            call('Page.startScreencast', {'format': 'jpeg', 'quality': 60, 'maxWidth': 1280, 'maxHeight': 720, 'everyNthFrame': 2}, session)
    call('Runtime.runIfWaitingForDebugger', session=session)
    targets[session]['initialized'] = True

def set_breakpoint(session, definition):
    result = call('Debugger.setBreakpointByUrl', {'url': definition['url'], 'lineNumber': definition['line'] - 1, 'condition': definition['condition']}, session)
    record = breakpoints.setdefault(definition['id'], {'definition': definition, 'handles': {}})
    record['handles'][session] = result['breakpointId']
    return result

def handle_event(message):
    method = message.get('method', '')
    data = message.get('params', {})
    session = message.get('sessionId')
    try:
        if method == 'Target.attachedToTarget':
            initialize(data['sessionId'], data['targetInfo'])
        elif method == 'Target.detachedFromTarget':
            targets.pop(data['sessionId'], None)
        elif method == 'Page.screencastFrame':
            observe('preview', {'image': data['data'], 'width': 1280, 'height': 720})
            call('Page.screencastFrameAck', {'sessionId': data['sessionId']}, session)
        elif method == 'Fetch.requestPaused':
            request = data['request']
            url = urllib.parse.urlsplit(request['url'])
            if url.scheme in ['data', 'blob'] or (url.scheme == 'http' and url.hostname == '127.0.0.1' and url.port == 8765):
                call('Fetch.continueRequest', {'requestId': data['requestId']}, session)
                return
            target_type = targets.get(session, {}).get('type', 'page')
            observe('request', {'url': request['url'], 'method': request['method'], 'requestId': data.get('networkId'), 'targetType': target_type})
            try:
                response = host_request(request)
                call('Fetch.fulfillRequest', {'requestId': data['requestId'], 'responseCode': response['status'], 'responseHeaders': response['headers'], 'body': response['body']}, session)
                observe('response', {'url': request['url'], 'status': response['status'], 'headers': response['headers'], 'body': response.get('capturedBody', response['body']), 'bodyBytes': response.get('bodyBytes'), 'truncated': response.get('truncated', False), 'requestId': data.get('networkId'), 'targetType': target_type})
            except Exception as error:
                observe('blocked', {'url': request['url'], 'reason': str(error), 'requestId': data.get('networkId'), 'targetType': target_type})
                call('Fetch.failRequest', {'requestId': data['requestId'], 'errorReason': 'BlockedByClient'}, session)
        elif method == 'Debugger.scriptParsed':
            if data.get('url') == 'wret://capability-probe':
                return
            script_urls[(session, data['scriptId'])] = data.get('url', '')
            if data.get('length', 0) > 1024 * 1024:
                observe('diagnostic', 'Script capture exceeds 1 MiB: ' + data.get('url', ''))
                return
            source = call('Debugger.getScriptSource', {'scriptId': data['scriptId']}, session).get('scriptSource', '')
            if len(source.encode()) <= 1024 * 1024:
                observe('script', {'url': data.get('url', ''), 'scriptId': data['scriptId'], 'source': source, 'target': session, 'sourceMapURL': data.get('sourceMapURL', '')})
        elif method == 'Debugger.paused':
            for frame in data.get('callFrames', []):
                frame['url'] = frame.get('url') or script_urls.get((session, frame['location']['scriptId']), '')
            observe('paused', {'target': session, **data})
        elif method == 'Debugger.resumed':
            observe('running', {'target': session})
        elif method in ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown']:
            observe('console' if method.endswith('consoleAPICalled') else 'exception', {'target': session, **data})
        elif method.startswith('Network.webSocket'):
            observe('websocket', {'event': method, **data})
        elif method in ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed']:
            target_type = targets.get(session, {}).get('type', 'page')
            request_id = data.get('requestId')
            if method == 'Network.requestWillBeSent' and request_id:
                network_contexts[(session, request_id)] = {
                    'url': data.get('request', {}).get('url', data.get('documentURL', '')),
                    'type': data.get('type', 'Other'),
                    'targetType': target_type,
                }
            elif method == 'Network.responseReceived' and request_id:
                network_contexts.setdefault((session, request_id), {}).update({
                    'url': data.get('response', {}).get('url', ''),
                    'mimeType': data.get('response', {}).get('mimeType', ''),
                    'status': data.get('response', {}).get('status'),
                    'targetType': target_type,
                })
            observe('network', {'event': method, 'targetType': target_type, **data})
        elif method == 'Network.loadingFinished':
            request_id = data.get('requestId')
            context = network_contexts.get((session, request_id), {})
            target_type = targets.get(session, {}).get('type', 'page')
            if data.get('encodedDataLength', 0) > 1024 * 1024:
                observe('resource', {'requestId': request_id, 'targetType': target_type, 'url': context.get('url', ''), 'mimeType': context.get('mimeType', ''), 'status': context.get('status'), 'bodyBytes': data.get('encodedDataLength', 0), 'truncated': True})
            else:
                try:
                    body = call('Network.getResponseBody', {'requestId': data['requestId']}, session)
                    raw = base64.b64decode(body.get('body', '')) if body.get('base64Encoded') else body.get('body', '').encode('utf-8', errors='replace')
                    observe('resource', {'requestId': request_id, 'targetType': target_type, 'url': context.get('url', ''), 'mimeType': context.get('mimeType', ''), 'status': context.get('status'), 'body': base64.b64encode(raw[:1024 * 1024]).decode('ascii'), 'bodyBytes': len(raw), 'truncated': len(raw) > 1024 * 1024})
                except Exception:
                    observe('resource', {'requestId': request_id, 'targetType': target_type, 'url': context.get('url', ''), 'mimeType': context.get('mimeType', ''), 'status': context.get('status'), 'bodyBytes': data.get('encodedDataLength', 0), 'truncated': True})
    except Exception as error:
        observe('diagnostic', method + ': ' + str(error))

def receive_cdp():
    try:
        while True:
            message = json.loads(cdp.recv())
            if 'id' in message:
                with pending_lock:
                    result = pending_cdp.get(message['id'])
                if result:
                    result.put(message)
            else:
                executor.submit(handle_event, message)
    except Exception as error:
        observe('failed', 'Chromium debugger disconnected: ' + str(error))

class EvidenceServer(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).lstrip('/')
        if path not in files and root_prefix + path in files:
            path = root_prefix + path
        if path == '__wret_harness.html':
            entry = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('entry', [''])[0]
            import html
            content = ('<!doctype html><meta charset="utf-8"><title>WRET JavaScript harness</title><script type="module" src="/' + html.escape(urllib.parse.quote(entry, safe='/'), quote=True) + '"></script>').encode()
            mime = 'text/html'
        elif path in files:
            content = files[path]
            mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)
    def log_message(self, *_):
        pass

def start(input):
    global cdp, main_session, root_prefix, pause_exceptions, live_edit_supported
    pause_exceptions = input.get('exceptionState', 'none')
    files.update({f['name']: base64.b64decode(f['bytes'], validate=True) for f in input['files']})
    if files:
        entry = input.get('entry', '')
        if '/' in entry:
            root_prefix = entry.split('/')[0] + '/'
    threading.Thread(target=http.server.ThreadingHTTPServer(('127.0.0.1', 8765), EvidenceServer).serve_forever, daemon=True).start()
    arguments = ['/usr/bin/chromium', '--headless=new', '--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1', '--user-data-dir=/tmp/wret-profile', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--no-default-browser-check', 'about:blank']
    # Container protocol tests use only checked-in benign fixtures. Production VM service never sets this flag.
    if test_stdio:
        arguments.insert(1, '--no-sandbox')
    subprocess.Popen(arguments, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    version = None
    for _ in range(150):
        try:
            version = json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=1))
            break
        except Exception:
            time.sleep(0.1)
    if not version:
        raise RuntimeError('Chromium startup failed')
    cdp = websocket.create_connection(version['webSocketDebuggerUrl'], suppress_origin=True, enable_multithread=True)
    threading.Thread(target=receive_cdp, daemon=True).start()
    existing = call('Target.getTargets')['targetInfos']
    target = next(t for t in existing if t['type'] == 'page')
    main_session = call('Target.attachToTarget', {'targetId': target['targetId'], 'flatten': True})['sessionId']
    # attach event initialization runs concurrently; explicitly wait for its completion.
    for _ in range(150):
        if targets.get(main_session, {}).get('initialized'):
            break
        time.sleep(0.1)
    else:
        raise RuntimeError('Debugger initialization timed out')
    for definition in input['breakpoints']:
        set_breakpoint(main_session, definition)
    if input['target'] == 'files':
        entry = input['entry']
        url = 'http://127.0.0.1:8765/' + urllib.parse.quote(entry, safe='/')
        if entry.lower().endswith(('.js', '.mjs', '.cjs')):
            url = 'http://127.0.0.1:8765/__wret_harness.html?entry=' + urllib.parse.quote(entry, safe='')
    else:
        url = input['target']
    features = ['snapshot', 'pausePolicy']
    unsupported = {}
    live_edit_supported = False
    try:
        probe = call('Runtime.compileScript', {'expression': 'void 0', 'sourceURL': 'wret://capability-probe', 'persistScript': True}, main_session)
        result = call('Debugger.setScriptSource', {'scriptId': probe['scriptId'], 'scriptSource': 'void 0', 'dryRun': True}, main_session)
        live_edit_supported = result.get('status', 'Ok') == 'Ok' and not result.get('exceptionDetails')
        if not live_edit_supported:
            raise RuntimeError('Chromium rejected the capability probe')
        features.append('liveEdit')
    except Exception:
        unsupported['liveEdit'] = 'Live script editing is unavailable in this Chromium build. Save a transformed derivative and execute it in a fresh session; this does not preserve runtime state.'
    observe('capabilities', {'features': features, 'unsupported': unsupported, 'agentVersion': 2})
    observe('running', {'url': url})
    call('Page.navigate', {'url': url}, main_session)
    return {'url': url}

def command(message):
    global pause_exceptions, skip_pauses
    try:
        action = message['command']
        kind = action['action']
        session = action.get('target') or main_session
        result = {}
        if kind == 'start':
            result = start(action['input'])
        elif kind in ['pause', 'resume', 'stepInto', 'stepOver', 'stepOut']:
            result = call('Debugger.' + kind, session=session)
        elif kind == 'exceptions':
            pause_exceptions = action['state']
            for target in list(targets):
                call('Debugger.setPauseOnExceptions', {'state': action['state']}, target)
        elif kind == 'breakpoint':
            for target in list(targets):
                result = set_breakpoint(target, action['breakpoint'])
        elif kind == 'removeBreakpoint':
            for target, handle in breakpoints.pop(action['id'], {}).get('handles', {}).items():
                call('Debugger.removeBreakpoint', {'breakpointId': handle}, target)
        elif kind == 'evaluate':
            params = {'expression': action['expression'], 'generatePreview': True, 'timeout': 5000}
            if action.get('callFrameId'):
                params['callFrameId'] = action['callFrameId']
                params.pop('timeout')
                result = call('Debugger.evaluateOnCallFrame', params, session)
            else:
                result = call('Runtime.evaluate', params, session)
            observe('evaluation', {'expression': action['expression'], 'result': result})
        elif kind == 'properties':
            result = call('Runtime.getProperties', {'objectId': action['objectId'], 'ownProperties': True, 'generatePreview': True}, session)
            observe('variables', result)
        elif kind == 'pausePolicy':
            changed = []
            try:
                for target in list(targets):
                    call('Debugger.setSkipAllPauses', {'skip': action['skip']}, target)
                    changed.append(target)
            except Exception:
                for target in changed:
                    try:
                        call('Debugger.setSkipAllPauses', {'skip': skip_pauses}, target)
                    except Exception as rollback_error:
                        observe('diagnostic', 'Pause-policy rollback failed: ' + str(rollback_error))
                observe('pausePolicy', {'skip': skip_pauses, 'partialFailure': True})
                raise
            skip_pauses = action['skip']
            result = {'skip': skip_pauses}
            observe('pausePolicy', result)
        elif kind == 'snapshot':
            result = {'heapUsage': call('Runtime.getHeapUsage', session=session), 'scopes': [], 'coverage': 'Shallow own properties; object contents, getters, DOM, sockets and full heap are not restored.'}
            for scope in action.get('scopes', [])[:12]:
                descriptors = call('Runtime.getProperties', {'objectId': scope['objectId'], 'ownProperties': True}, session).get('result', [])
                properties = []
                for descriptor in descriptors[:200]:
                    remote = descriptor.get('value', {})
                    item = {'name': str(descriptor.get('name', ''))[:200], 'type': remote.get('type', 'accessor'), 'description': str(remote.get('description', ''))[:300]}
                    if 'get' in descriptor or 'set' in descriptor:
                        item['accessor'] = True
                    elif 'value' in remote and (remote['value'] is None or isinstance(remote['value'], (str, bool, int, float))):
                        item['value'] = remote['value'][:300] if isinstance(remote['value'], str) else remote['value']
                    elif 'unserializableValue' in remote:
                        item['value'] = remote['unserializableValue']
                    properties.append(item)
                result['scopes'].append({'name': scope['name'], 'properties': properties, 'truncated': len(descriptors) > 200})
            observe('snapshot', result)
        elif kind == 'liveEdit':
            if not live_edit_supported:
                raise RuntimeError('Live script editing is unavailable in this Chromium build')
            scripts = [ident for (target, ident), url in script_urls.items() if target == session and url == action['url']]
            if len(scripts) != 1:
                raise RuntimeError('Choose a unique loaded script in the selected target; source maps and duplicate URLs cannot be patched directly.')
            result = call('Debugger.setScriptSource', {'scriptId': scripts[0], 'scriptSource': action['source'], 'dryRun': action['dryRun'], 'allowTopFrameEditing': False}, session)
            status = result.get('status', 'CompileError' if result.get('exceptionDetails') else 'Ok')
            result['status'] = status
            record = {'url': action['url'], 'dryRun': action['dryRun'], 'status': status}
            if not action['dryRun'] and status == 'Ok':
                record['source'] = action['source']
                if result.get('callFrames'):
                    observe('paused', {'target': session, 'callFrames': result['callFrames'], 'reason': 'liveEdit'})
            observe('liveEdit', record)
        elif kind == 'input':
            if kind and action['type'].startswith('mouse'):
                result = call('Input.dispatchMouseEvent', {'type': action['type'], 'x': action.get('x', 0), 'y': action.get('y', 0), 'button': 'left', 'clickCount': 1}, main_session)
            else:
                result = call('Input.dispatchKeyEvent', {'type': action['type'], 'key': action.get('key', ''), 'text': action.get('text', '')}, main_session)
        else:
            raise RuntimeError('Unsupported debugger command')
        send({'reply': message['id'], 'result': result})
    except Exception as error:
        send({'reply': message['id'], 'error': str(error)})

observe('ready', {})
while True:
    line = control_reader.readline(140 * 1024 * 1024)
    if not line:
        time.sleep(0.1)
        continue
    try:
        message = json.loads(line)
        if 'reply' in message:
            with pending_lock:
                result = pending_host.get(message['reply'])
            if result:
                result.put(message)
        else:
            command_executor.submit(command, message)
    except Exception as error:
        observe('diagnostic', str(error))
