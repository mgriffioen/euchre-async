// Displays a dot-based tricks-taken tracker for both teams during the playing phase.

function DotRow({ filled }: { filled: number }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className={`g-dot${i < filled ? " filled" : ""}`} />
      ))}
    </div>
  );
}

export default function TrickMeter(props: {
  aLabel: string;
  aCount: number;
  bLabel: string;
  bCount: number;
}) {
  const { aLabel, aCount, bLabel, bCount } = props;

  return (
    <div className="g-card" style={{ marginBottom: 8, padding: "8px 12px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 28px", gap: 8, rowGap: 8 }}>
        <div style={{ fontWeight: 700 }}>{aLabel}</div>
        <DotRow filled={aCount} />
        <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{aCount}</div>

        <div style={{ fontWeight: 700 }}>{bLabel}</div>
        <DotRow filled={bCount} />
        <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{bCount}</div>
      </div>
    </div>
  );
}
