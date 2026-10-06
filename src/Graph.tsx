import type { Project, Location, Item } from "./model";
export function Graph({
  project,
  navigate,
}: {
  project: Project;
  navigate: (l: Location) => void;
}) {
  const nodes: {
    id: string;
    label: string;
    x: number;
    y: number;
    kind: string;
    location: Location;
  }[] = [];
  const edges: { from: string; to: string; kind: string }[] = [];
  let functionRow = 0,
    findingRow = 0;
  project.files.slice(0, 20).forEach((f, i) => {
    nodes.push({
      id: f.id,
      label: f.name,
      kind: "file",
      x: 20,
      y: 55 + i * 60,
      location: { fileId: f.id, start: 0, end: 0 },
    });
    const add = (item: Item, kind: string) => {
      nodes.push({
        id: item.id,
        label:
          project.notes.find(
            (n) =>
              n.kind === "label" &&
              n.location.fileId === item.location.fileId &&
              n.location.start === item.location.start,
          )?.text || item.name,
        x: kind === "function" ? 300 : 580,
        y: 55 + (kind === "function" ? functionRow++ : findingRow++) * 60,
        kind,
        location: item.location,
      });
      edges.push({ from: f.id, to: item.id, kind: "contains" });
    };
    const visibleFunctions =
      f.result?.outline
        .filter((x) => x.kind === "function" || x.kind === "wasm func")
        .slice(0, 10) || [];
    visibleFunctions.forEach((x) => add(x, "function"));
    f.result?.findings.slice(0, 10).forEach((x) => {
      add(x, "finding");
      const owner = visibleFunctions
        .filter(
          (fn) =>
            fn.location.start <= x.location.start &&
            fn.location.end >= x.location.end,
        )
        .sort(
          (a, b) =>
            a.location.end -
            a.location.start -
            (b.location.end - b.location.start),
        )[0];
      if (owner) edges.push({ from: owner.id, to: x.id, kind: "contains" });
    });
    f.result?.calls
      .filter((c) => c.target)
      .slice(0, 100)
      .forEach((c) => {
        const owner = f.result?.outline
          .filter(
            (o) =>
              o.kind === "function" &&
              o.location.start <= c.location.start &&
              o.location.end >= c.location.end,
          )
          .sort(
            (a, b) =>
              a.location.end -
              a.location.start -
              (b.location.end - b.location.start),
          )[0];
        edges.push({ from: owner?.id || f.id, to: c.target!, kind: "call" });
      });
  });
  return (
    <div className="graph-view">
      <p className="view-help">
        Click a node to inspect its original evidence. Solid lines: containment.
        Dashed lines: statically resolved calls. View shows up to 20 files and
        10 functions/findings and 100 calls per file.
      </p>
      <svg
        role="img"
        aria-label="Evidence relationship graph"
        width="840"
        height={Math.max(
          400,
          100 +
            Math.max(
              Math.min(20, project.files.length),
              functionRow,
              findingRow,
            ) *
              60,
        )}
      >
        <text x="20" y="26" className="graph-heading">
          FILES
        </text>
        <text x="300" y="26" className="graph-heading">
          FUNCTIONS
        </text>
        <text x="580" y="26" className="graph-heading">
          FINDINGS
        </text>
        {edges.map((e, i) => {
          const a = nodes.find((n) => n.id === e.from),
            b = nodes.find((n) => n.id === e.to);
          return a && b ? (
            <path
              key={i}
              d={`M ${a.x + 220} ${a.y + 17} C ${a.x + 250} ${a.y + 17}, ${b.x - 50} ${b.y + 17}, ${b.x} ${b.y + 17}`}
              fill="none"
              stroke={e.kind === "call" ? "#7ddbc6" : "#334856"}
              strokeDasharray={e.kind === "call" ? "5 4" : undefined}
            />
          ) : null;
        })}
        {nodes.map((n) => (
          <g
            key={n.id}
            role="button"
            tabIndex={0}
            aria-label={`Inspect ${n.label}`}
            onClick={() => navigate(n.location)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(n.location);
            }}
            className={`graph-node ${n.kind}`}
          >
            <rect x={n.x} y={n.y} width="220" height="36" rx="5" />
            <text x={n.x + 10} y={n.y + 23}>
              {n.label.length > 27 ? n.label.slice(0, 25) + "…" : n.label}
            </text>
            <title>{n.label}</title>
          </g>
        ))}
      </svg>
    </div>
  );
}
