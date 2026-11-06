export function formatVectorLiteral(values: number[], dimensions: number): string {
  if (values.length !== dimensions) {
    throw Object.assign(new Error("dimension_mismatch"), { name: "DimensionMismatch" });
  }
  const parts = values.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw Object.assign(new Error("invalid_embedding"), { name: "InvalidEmbedding" });
    }
    return formatDecimal(value);
  });
  return `[${parts.join(",")}]`;
}

function formatDecimal(value: number): string {
  if (Object.is(value, -0) || value === 0) return "0";
  const negative = value < 0;
  const text = Math.abs(value).toFixed(15).replace(/\.?0+$/, "") || "0";
  return negative ? `-${text}` : text;
}
