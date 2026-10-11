import { useMemo, useState } from "react";
import type { Analysis, WasmAlias, WasmFunction, WasmInstruction } from "./model";

const ROW = 30, WINDOW = 44;
export function WasmView({ analysis, aliases, onAlias, onBytes }: {
  analysis: Analysis; aliases: WasmAlias[]; onAlias: (index: number, name: string) => void;
  onBytes: (start: number, end: number) => void;
}) {
  const [pane, setPane] = useState<"Instructions" | "Functions" | "Imports & Exports" | "References">("Instructions");
  const [query, setQuery] = useState(""), [scroll, setScroll] = useState(0), [rename, setRename] = useState<number>();
  const functions = analysis.wasmFunctions || [], instructions = analysis.wasmInstructions || [];
  const aliasMap = useMemo(() => new Map(aliases.filter(x => x.moduleHash === analysis.hash).map(x => [x.functionIndex, x.name])), [aliases, analysis.hash]);
  const matches = useMemo(() => instructions.filter(i => !query || `${i.opcode} ${i.operands} ${aliasMap.get(i.functionIndex) || ""} func${i.functionIndex} ${i.callTarget === undefined ? "" : `func${i.callTarget}`}`.toLowerCase().includes(query.toLowerCase())), [instructions, query, aliasMap]);
  const first = Math.max(0, Math.floor(scroll / ROW) - 5), visible = matches.slice(first, first + WINDOW);
  const functionName = (index: number) => aliasMap.get(index) || functions[index]?.name || `func${index}`;
  return <section className="wasm-workbench" aria-label="WebAssembly investigation">
    <div className="wasm-toolbar">
      <div className="wasm-subtabs" role="tablist" aria-label="Wasm views">{(["Instructions", "Functions", "Imports & Exports", "References"] as const).map(x => <button key={x} role="tab" aria-selected={pane === x} className={pane === x ? "active" : ""} onClick={() => setPane(x)}>{x}</button>)}</div>
      <input aria-label="Search WebAssembly instructions and functions" placeholder="Search opcodes, operands, and functions" value={query} onChange={e => {setQuery(e.target.value);setScroll(0);}} />
    </div>
    {analysis.wasmCoverage?.reason && <p className="wasm-coverage" role="status">Partial instruction coverage: {analysis.wasmCoverage.reason} Unsupported instruction bytes are retained and can still be inspected in Original bytes.</p>}
    {pane === "Instructions" && <>
      <p className="wasm-help">Decoded without executing the module. Selecting an instruction opens its original byte range. Function names are analyst aliases; original bytes and module hashes stay unchanged.</p>
      <div className="wasm-instruction-head"><span>BYTE</span><span>FUNCTION</span><span>INSTRUCTION</span><span>REFERENCE</span></div>
      <div className="wasm-instruction-scroll" role="list" aria-label="WebAssembly instructions" onScroll={e => setScroll(e.currentTarget.scrollTop)}>
        <div style={{height:first*ROW, position:"relative"}} />
        {visible.map((inst, n) => <Instruction key={`${inst.functionIndex}:${inst.offset}:${n}`} instruction={inst} functionName={functionName} onBytes={onBytes} />)}
        <div style={{height:Math.max(0,(matches.length-first-visible.length)*ROW)}} />
        {!matches.length && <p className="empty-small">No matching instructions.</p>}
      </div>
      <div className="wasm-count">{matches.length.toLocaleString()} indexed instructions · {functions.length.toLocaleString()} functions · {analysis.hash.slice(0,16)}…</div>
    </>}
    {pane === "Functions" && <div className="wasm-list" role="list" aria-label="WebAssembly functions">{functions.filter(f => !query || `${f.index} ${f.name} ${aliasMap.get(f.index)||""}`.toLowerCase().includes(query.toLowerCase())).map(fn => <FunctionRow key={fn.index} fn={fn} alias={aliasMap.get(fn.index)} renaming={rename===fn.index} onRename={() => setRename(fn.index)} onSave={name => {onAlias(fn.index,name);setRename(undefined);}} onCancel={() => setRename(undefined)} onBytes={onBytes} />)}</div>}
    {pane === "Imports & Exports" && <div className="wasm-list" role="list" aria-label="Wasm imports and exports">{analysis.outline.filter(x => x.kind === "wasm import" || x.kind === "wasm export").filter(x => !query || `${x.kind} ${x.name}`.toLowerCase().includes(query.toLowerCase())).map(x => <button className="wasm-outline-row" key={x.id} onClick={() => onBytes(x.location.start,x.location.end)}><strong>{x.kind}</strong><span>{x.name}</span><small>{x.location.start.toString(16).padStart(8,"0")}–{x.location.end.toString(16).padStart(8,"0")}</small></button>)}</div>}
    {pane === "References" && <div className="wasm-list" role="list" aria-label="Direct WebAssembly call references">{instructions.filter(x => x.callTarget !== undefined).filter(x => !query || `${functionName(x.functionIndex)} ${functionName(x.callTarget!)} ${x.offset}`.toLowerCase().includes(query.toLowerCase())).map(x => <button className="wasm-outline-row" key={`${x.functionIndex}-${x.offset}`} onClick={() => onBytes(x.offset,x.end)}><strong>{functionName(x.functionIndex)}</strong><span>calls {functionName(x.callTarget!)}</span><small>byte 0x{x.offset.toString(16)}</small></button>)}{!instructions.some(x=>x.callTarget!==undefined)&&<p className="empty-small">No direct call instructions were indexed.</p>}</div>}
  </section>;
}
function Instruction({instruction:i,functionName,onBytes}:{instruction:WasmInstruction;functionName:(index:number)=>string;onBytes:(a:number,b:number)=>void}) { return <button role="listitem" className="wasm-instruction-row" onClick={()=>onBytes(i.offset,i.end)} title={`Inspect original bytes 0x${i.offset.toString(16)}–0x${i.end.toString(16)}`}><span>0x{i.offset.toString(16).padStart(8,"0")}</span><span>{functionName(i.functionIndex)}</span><code>{i.opcode}{i.operands?` ${i.operands}`:""}</code><span>{i.callTarget===undefined?"":`→ ${functionName(i.callTarget)}`}</span></button>; }
function FunctionRow({fn,alias,renaming,onRename,onSave,onCancel,onBytes}:{fn:WasmFunction;alias?:string;renaming:boolean;onRename:()=>void;onSave:(name:string)=>void;onCancel:()=>void;onBytes:(a:number,b:number)=>void}) { const [value,setValue]=useState(alias||""); return <div className="wasm-function-row"><span>#{fn.index}</span><span><strong>{alias||fn.name}</strong>{alias&&<small>Original: {fn.name}</small>}{fn.imported&&<small>Imported</small>}</span>{renaming?<><input autoFocus aria-label={`Alias for function ${fn.index}`} value={value} maxLength={128} onChange={e=>setValue(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")onSave(value);if(e.key==="Escape")onCancel();}}/><button onClick={()=>onSave(value)}>Save name</button><button onClick={onCancel}>Cancel</button></>:<><button onClick={onRename} aria-label={`Rename ${alias||fn.name}`}>Rename</button>{alias&&<button onClick={()=>onSave("")} aria-label={`Reset alias for function ${fn.index}`}>Reset</button>}</>}{fn.location&&<button onClick={()=>onBytes(fn.location!.start,fn.location!.end)}>Body bytes</button>}</div>; }
