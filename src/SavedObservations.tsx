import { useMemo, useState } from "react";
import type { Project } from "./model";
import type { DebugSession, Observation } from "./debug-types";

function SavedRecord({ session, observation }: { session: DebugSession; observation: Observation }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{observation.kind} · {observation.time} · #{observation.sequence}</summary>
    {open && <><p>{session.target} · recorded session {session.id}</p>
      <p>Payload preview is limited to 100,000 characters. Export includes the complete retained record.</p>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(observation.data, null, 2)?.slice(0, 100000)}</pre></>}
  </details>;
}

export function SavedObservations({ project }: { project: Project }) {
  const [filter, setFilter] = useState("");
  const records = useMemo(() => (project.sessions || []).flatMap(session => session.observations.map(observation => ({ session, observation }))), [project.sessions]);
  const matches = useMemo(() => filter ? records.filter(({ session, observation }) => `${session.target} ${observation.kind} ${JSON.stringify(observation.data)}`.toLowerCase().includes(filter.toLowerCase())) : records, [records, filter]);
  return <section className="guided-overview" aria-labelledby="saved-observations-title">
    <h1 id="saved-observations-title">Saved observations</h1>
    <p>Historical records imported from projects. Whidra does not run evidence or reconnect to these sessions. Report exports include all retained observations.</p>
    <label>Filter saved observations <input value={filter} onChange={event => setFilter(event.target.value)} type="search" /></label>
    <p role="status">{matches.length} matching records · showing up to 500</p>
    {!records.length && <p>No saved observations. Import a project containing captured observations, or import HAR requests in Network.</p>}
    {records.length > 0 && !matches.length && <p>No observations match this filter.</p>}
    {matches.slice(0, 500).map(({ session, observation }) => <SavedRecord key={`${session.id}:${observation.sequence}`} session={session} observation={observation} />)}
    {(project.breakpoints || []).length > 0 && <details><summary>Historical breakpoints ({project.breakpoints!.length})</summary><p>Retained as project records; execution is unavailable.</p><ul>{project.breakpoints!.map(point => <li key={point.id}>{point.url}:{point.line + 1}{point.condition ? ` · ${point.condition}` : ""}</li>)}</ul></details>}
  </section>;
}
