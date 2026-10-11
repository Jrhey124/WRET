# Whidra local debugger companion

Static deployment works without a companion. Dynamic debugging uses the local Node service, QEMU, and a disposable Linux guest. The real Windows VM integration suite must pass before treating this debugger as release validated.

The companion keeps its established `WRET_*` environment variables, `.wret-vm` directory, and `org.wret.control` guest channel so existing installations continue to work.

## Windows setup

1. Install Node.js 24 and QEMU for Windows from a trusted distribution. Enable hardware virtualization in firmware.
2. Enable **Windows Hypervisor Platform** in Windows optional features and restart. Explicitly request this from an elevated terminal with `scripts/setup-companion.ps1 -EnableHypervisor` if desired.
3. Put QEMU on PATH, or set both executable paths:

```powershell
$env:WRET_QEMU = 'C:\Program Files\qemu\qemu-system-x86_64.exe'
$env:WRET_QEMU_IMG = 'C:\Program Files\qemu\qemu-img.exe'
npm.cmd ci
```

4. Prepare the guest below and place `guest.qcow2` and `guest.sha256` together in `.wret-vm`. Configure another directory with `WRET_VM_DIR`.
5. Run `scripts/setup-companion.ps1`, then `npm.cmd run companion`. Open **http://127.0.0.1:8080**. Use that exact hostname; aliases are rejected by the API. Change the port with `WRET_PORT` if Docker already occupies 8080.

Only enabling the Windows optional feature requires elevation. The runtime and its diskless WHPX prerequisite probe run under your ordinary user account.

## Guest preparation

The automated procedure runs on a Linux builder with `guestfs-tools`, `qemu-system-x86`, and virtualization available. Confirm the template with `virt-builder --list`, then run:

```sh
sh guest/build-image.sh /absolute/output/guest.qcow2
```

The script installs Chromium, Python's WebSocket client, nftables, and the agent, then writes a checksum. Preserve the resulting image and checksum for repeatable sessions. Templates and package repositories can change; this procedure does not claim byte-identical rebuilds. Retain the release image and record its template provenance and package versions. See [virt-builder documentation](https://libguestfs.org/virt-builder.1.html).

For manual Windows preparation, create a clean Debian x64 qcow2 VM with QEMU and a verified Debian installer. During preparation only, allow networking and copy `guest/agent.py` and `guest/provision.sh` into the guest. In that directory run `sudo sh provision.sh`, then power off the VM and copy its disk to `.wret-vm/guest.qcow2`. Write the checksum:

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath '.wret-vm/guest.qcow2').Hash.ToLowerInvariant() | Set-Content '.wret-vm/guest.sha256'
```

The checksum detects image changes; it does not establish trust in an unknown image. Runtime uses `-nic none` and a fresh overlay. The guest agent runs unprivileged, with the Chromium sandbox enabled.

## Investigation

Import files or a folder. In **Debug**, check the companion and choose an HTML entrypoint or JavaScript module harness. Imported resources have URLs of the form `http://127.0.0.1:8765/<imported-path>`. Add breakpoints before starting when investigating startup code.

For a URL session, enter an HTTP(S) URL and approve its origin explicitly. Every additional origin needs separate approval. Each broker request resolves and validates addresses and pins the chosen address to the connection. Redirects are separate intercepted requests. Host, private, reserved, and link-local destinations and nonstandard ports are rejected. The guest has no network adapter.

Use stepping, exception pauses, scopes, and console/watch evaluation. Evaluation executes in the guest. Stack frames navigate to supplied or captured source. The preview forwards clicks and keyboard events; target HTML never executes in the workbench.

Harnesses provide browser APIs, not Node.js APIs. External WebSocket transport is blocked in this implementation; attempted connections and available events are captured. The broker currently supports bounded HTTP(S) requests, so sites requiring streaming, service-worker-specific behavior, or WebSockets may not work completely. Resources can transfer up to 25 MiB; captured response bodies retain only the first 1 MiB and mark truncation. Request bodies are limited to 1 MiB. Runtime capture stops at 50 MiB or 50,000 events; the latest 100 observations appear on screen.

Stop destroys the disk overlay and browser profile. Sessions expire after 30 minutes; **Extend** resets the deadline. Startup cleans recorded session overlays and terminates matching orphan QEMU processes before deletion. Keep the companion running; reconnect replays retained observations.

Export saves observations, captured source, notes, and breakpoints, stripping live debugger handles and common credential headers. Arbitrary code/payloads may still contain sensitive data; review evidence before sharing. Restored projects do not restore live debugger objects.

## Verification and troubleshooting

```powershell
npm.cmd test
npm.cmd run companion:check
npm.cmd run build
$env:WRET_BROWSER = 'msedge'
npm.cmd run test:e2e
npm.cmd run test:vm
```

The VM suite requires actual Windows prerequisites and fails when they are missing. It never substitutes a host browser. The first companion serves its UI locally; a remote static hosted origin does not connect to it.

- **Image mismatch:** replace the image/checksum together from a trusted build.
- **WHPX unavailable:** enable Windows Hypervisor Platform and firmware virtualization, then reboot.
- **Startup timeout:** check the guest virtio port udev rule, enabled `wret-agent` unit, boot configuration, and unprivileged Chromium sandbox using trusted fixtures.
- **Missing resources:** import the complete folder. External resources need approvals. Absolute paths resolve against the selected entrypoint's imported folder root.
- **Connection/storage failures:** reconnect to replay records; export immediately if browser checkpoint saving fails.
