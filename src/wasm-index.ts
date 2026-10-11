import type { WasmFunction, WasmInstruction } from "./model";

export interface WasmIndex { functions: WasmFunction[]; instructions: WasmInstruction[]; total: number; reason?: string; }

/** A bounded, non-executing reader for the WebAssembly 1.0 instruction set.
 * Proposal opcodes that need a proposal-specific immediate format stop decoding
 * that function instead of risking false byte offsets. */
export function indexWasm(bytes: Uint8Array, fileId: string, maxInstructions = 100_000): WasmIndex {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 97 || bytes[2] !== 115 || bytes[3] !== 109 || bytes[4] !== 1 || bytes[5] || bytes[6] || bytes[7]) throw new Error("Invalid or truncated WASM v1 header");
  let p = 8, imported: WasmFunction[] = [], definedTypes: number[] = [], codeBodies: { start: number; end: number }[] = [];
  const u = (limit = bytes.length): number => { let n = 0, shift = 0; for (let i=0;i<5;i++) { if (p >= limit) throw new Error("Truncated LEB128"); const b=bytes[p++]; n += (b & 127) * 2 ** shift; if (!(b & 128)) return n; shift += 7; } throw new Error("Invalid LEB128"); };
  const str = (end: number) => { const len=u(end); if (p+len>end) throw new Error("Truncated Wasm name"); const s=new TextDecoder("utf-8",{fatal:false}).decode(bytes.subarray(p,p+len)); p+=len; return s; };
  while (p < bytes.length) {
    const id=bytes[p++], size=u(), end=p+size; if (end>bytes.length) throw new Error("Truncated Wasm section");
    if (id===2) { const count=u(end); if(count>250_000)throw new Error("Wasm import count exceeds the index limit"); for(let i=0;i<count;i++){const module=str(end), name=str(end), kind=bytes[p++]; if(kind===0){const typeIndex=u(end); imported.push({index:imported.length, imported:true, name:`${module}.${name}`, typeIndex});} else if(kind===1){p++; const flags=u(end); if(flags&1) u(end);} else if(kind===2){const flags=u(end); u(end); if(flags&1) u(end);} else if(kind===3){p+=2;} else if(kind===4){u(end);u(end);} else throw new Error("Unknown Wasm import kind"); if(p>end)throw new Error("Truncated Wasm import");} }
    else if(id===3){const n=u(end);if(n>250_000)throw new Error("Wasm function count exceeds the index limit");for(let i=0;i<n;i++)definedTypes.push(u(end));}
    else if(id===10){const n=u(end);if(n>250_000)throw new Error("Wasm code count exceeds the index limit");for(let i=0;i<n;i++){const length=u(end), start=p, bodyEnd=p+length;if(bodyEnd>end)throw new Error("Truncated Wasm function body");codeBodies.push({start,end:bodyEnd});p=bodyEnd;}}
    p=end;
  }
  const functions: WasmFunction[]=[...imported];
  for(let i=0;i<definedTypes.length;i++){const body=codeBodies[i];functions.push({index:functions.length,imported:false,name:`func${functions.length}`,typeIndex:definedTypes[i],location:body?{fileId,start:body.start,end:body.end}:undefined});}
  const instructions: WasmInstruction[]=[]; let total=0, reason:string|undefined;
  const names = new Map<number,string>();
  const explicit: Record<number,string>={0x00:"unreachable",0x01:"nop",0x02:"block",0x03:"loop",0x04:"if",0x05:"else",0x0b:"end",0x0c:"br",0x0d:"br_if",0x0e:"br_table",0x0f:"return",0x10:"call",0x11:"call_indirect",0x1a:"drop",0x1b:"select",0x20:"local.get",0x21:"local.set",0x22:"local.tee",0x23:"global.get",0x24:"global.set",0x25:"table.get",0x26:"table.set",0x28:"i32.load",0x29:"i64.load",0x2a:"f32.load",0x2b:"f64.load",0x36:"i32.store",0x37:"i64.store",0x38:"f32.store",0x39:"f64.store",0x3f:"memory.size",0x40:"memory.grow",0x41:"i32.const",0x42:"i64.const",0x43:"f32.const",0x44:"f64.const",0xd0:"ref.null",0xd1:"ref.is_null",0xd2:"ref.func"};
  const opcodeNames = [
    [0x45, "i32.eqz"], [0x46, "i32.eq"], [0x47, "i32.ne"], [0x48, "i32.lt_s"], [0x49, "i32.lt_u"], [0x4a, "i32.gt_s"], [0x4b, "i32.gt_u"], [0x4c, "i32.le_s"], [0x4d, "i32.le_u"], [0x4e, "i32.ge_s"], [0x4f, "i32.ge_u"],
    [0x50, "i64.eqz"], [0x51, "i64.eq"], [0x52, "i64.ne"], [0x53, "i64.lt_s"], [0x54, "i64.lt_u"], [0x55, "i64.gt_s"], [0x56, "i64.gt_u"], [0x57, "i64.le_s"], [0x58, "i64.le_u"], [0x59, "i64.ge_s"], [0x5a, "i64.ge_u"],
    ...["f32","f64"].flatMap((type, n) => ["eq","ne","lt","gt","le","ge"].map((op, i) => [0x5b+n*6+i, `${type}.${op}`] as [number,string])),
    ...["i32","i64"].flatMap((type,n)=>["clz","ctz","popcnt","add","sub","mul","div_s","div_u","rem_s","rem_u","and","or","xor","shl","shr_s","shr_u","rotl","rotr"].map((op,i)=>[0x67+n*18+i,`${type}.${op}`] as [number,string])),
    ...["f32","f64"].flatMap((type,n)=>["abs","neg","ceil","floor","trunc","nearest","sqrt","add","sub","mul","div","min","max","copysign"].map((op,i)=>[0x8b+n*14+i,`${type}.${op}`] as [number,string])),
    [0xa7,"i32.wrap_i64"],[0xa8,"i32.trunc_f32_s"],[0xa9,"i32.trunc_f32_u"],[0xaa,"i32.trunc_f64_s"],[0xab,"i32.trunc_f64_u"],[0xac,"i64.extend_i32_s"],[0xad,"i64.extend_i32_u"],[0xae,"i64.trunc_f32_s"],[0xaf,"i64.trunc_f32_u"],[0xb0,"i64.trunc_f64_s"],[0xb1,"i64.trunc_f64_u"],[0xb2,"f32.convert_i32_s"],[0xb3,"f32.convert_i32_u"],[0xb4,"f32.convert_i64_s"],[0xb5,"f32.convert_i64_u"],[0xb6,"f32.demote_f64"],[0xb7,"f64.convert_i32_s"],[0xb8,"f64.convert_i32_u"],[0xb9,"f64.convert_i64_s"],[0xba,"f64.convert_i64_u"],[0xbb,"f64.promote_f32"],[0xbc,"i32.reinterpret_f32"],[0xbd,"i64.reinterpret_f64"],[0xbe,"f32.reinterpret_i32"],[0xbf,"f64.reinterpret_i64"],[0xc0,"i32.extend8_s"],[0xc1,"i32.extend16_s"],[0xc2,"i64.extend8_s"],[0xc3,"i64.extend16_s"],[0xc4,"i64.extend32_s"],
  ] as [number,string][];
  for (const [opcode,name] of opcodeNames) names.set(opcode,name);
  Object.entries(explicit).forEach(([k,v])=>names.set(+k,v));
  const readSigned=(limit:number,bits:number)=>{let value=0n,shift=0n,b=0,iterations=0;do{if(p>=limit)throw new Error("Truncated signed LEB128");if(++iterations>Math.ceil(bits/7))throw new Error("Invalid signed LEB128");b=bytes[p++];value|=BigInt(b&127)<<shift;shift+=7n;}while(b&128);if(b&64)value|=(-1n)<<shift;return value.toString();};
  const readBlockType=(limit:number)=>{if(p>=limit)throw new Error("Truncated block type");let b=bytes[p];if([0x40,0x7f,0x7e,0x7d,0x7c,0x70,0x6f].includes(b)){p++;return `0x${b.toString(16)}`;}return String(readSigned(limit,33));};
  for(let bi=0;bi<codeBodies.length;bi++){
    const body=codeBodies[bi], limit=body.end, index=imported.length+bi, localStart=p; p=body.start;
    try{
      const localGroups=u(limit); for(let x=0;x<localGroups;x++){u(limit);p++;if(p>limit)throw new Error("Truncated local declaration");}
      let depth=0;
      while(p<limit){if(total>=maxInstructions){reason=`Instruction index capped at ${maxInstructions}; remaining functions are not indexed.`;break;}
        const offset=p, op=bytes[p++]; let operands="", callTarget:number|undefined;
        if(op===0x02||op===0x03||op===0x04) {operands=readBlockType(limit);depth++;}
        else if(op===0x0c||op===0x0d||op===0x10||op===0x20||op===0x21||op===0x22||op===0x23||op===0x24||op===0x25||op===0x26||op===0xd2){const n=u(limit);operands=String(n);if(op===0x10){callTarget=n;}}
        else if(op===0x0e){const n=u(limit);const labels=[];for(let x=0;x<n;x++)labels.push(u(limit));labels.push(u(limit));operands=labels.join(", ");}
        else if(op===0x11){const t=u(limit),table=u(limit);operands=`type ${t}, table ${table}`;}
        else if(op===0x1c){const n=u(limit);const ts=[];for(let x=0;x<n;x++)ts.push(bytes[p++].toString(16));operands=ts.join(",");}
        else if(op>=0x28&&op<=0x3e){const a=u(limit),o=u(limit);operands=`align=${a}, offset=${o}`;}
        else if(op===0x3f||op===0x40){operands=`memory ${u(limit)}`;}
        else if(op===0x41){operands=String(readSigned(limit,32));}
        else if(op===0x42){operands=String(readSigned(limit,64));}
        else if(op===0x43){if(p+4>limit)throw new Error("Truncated f32 constant");operands=Array.from(bytes.subarray(p,p+4)).map(x=>x.toString(16).padStart(2,"0")).join("");p+=4;}
        else if(op===0x44){if(p+8>limit)throw new Error("Truncated f64 constant");operands=Array.from(bytes.subarray(p,p+8)).map(x=>x.toString(16).padStart(2,"0")).join("");p+=8;}
        else if(op===0xd0){operands=`heaptype ${readSigned(limit,33)}`;}
        else if(op===0xfc){const sub=u(limit);operands=`${sub}`;if(sub<=7){}else if(sub===8){operands+=`, data ${u(limit)}, memory ${u(limit)}`;}else if(sub===9){operands+=`, data ${u(limit)}`;}else if(sub===10){operands+=`, memory ${u(limit)}, memory ${u(limit)}`;}else if(sub===11){operands+=`, memory ${u(limit)}`;}else if(sub===12){operands+=`, elem ${u(limit)}, table ${u(limit)}`;}else if(sub===13){operands+=`, elem ${u(limit)}`;}else if(sub===14){operands+=`, table ${u(limit)}, table ${u(limit)}`;}else if(sub>=15&&sub<=17){operands+=`, table ${u(limit)}`;}else throw new Error(`Unsupported 0xfc opcode ${sub}`);}
        else if(op===0x05){if(depth<1)throw new Error("Unmatched else");}
        else if(op===0x0b){if(depth===0&&p===limit){instructions.push({functionIndex:index,offset,end:p,opcode:"end",operands:""});total++;break;}depth--;}
        else if(!names.has(op)){reason=`Unsupported opcode 0x${op.toString(16)} at byte ${offset}; this function is only partially indexed.`;break;}
        instructions.push({functionIndex:index,offset,end:p,opcode:names.get(op)!,operands,callTarget});total++;
      }
    }catch(error){reason=`Function ${index} instruction decoding stopped: ${String(error)}`;}
    if(p>limit)p=limit; if(reason) { /* continue indexing subsequent bodies where possible */ }
  }
  return {functions,instructions,total,reason};
}
