export function DemoBadge() {
  if (process.env.NEXT_PUBLIC_APP_MODE === "production") return null;
  return (
    <div className="demoBadge" role="status">
      演示版 · 数据可能重置
    </div>
  );
}
