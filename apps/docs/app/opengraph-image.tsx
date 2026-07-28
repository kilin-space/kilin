import { ImageResponse } from "next/og";

export const alt = "Kilin Documentation";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function OpenGraphImage(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "linear-gradient(135deg, #1b1d22 0%, #101114 70%)",
        display: "flex",
        gap: 56,
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <svg width="180" height="180" viewBox="0 0 128 128">
        <rect width="128" height="128" rx="24" fill="#24262B" />
        <rect
          x="7"
          y="7"
          width="114"
          height="114"
          rx="18"
          fill="none"
          stroke="#6E5E42"
          strokeWidth="2"
        />
        <path d="M47 30 L47 55" fill="none" stroke="#FAFBFC" strokeWidth="8" />
        <path d="M47 73 L47 98" fill="none" stroke="#FAFBFC" strokeWidth="8" />
        <path d="M81 30 L53.36 57.64" fill="none" stroke="#FAFBFC" strokeWidth="8" />
        <path d="M53.36 70.36 L81 98" fill="none" stroke="#FAFBFC" strokeWidth="8" />
        <circle cx="47" cy="30" r="9" fill="#FAFBFC" />
        <circle cx="47" cy="98" r="9" fill="#FAFBFC" />
        <circle cx="81" cy="30" r="9" fill="#FAFBFC" />
        <circle cx="81" cy="98" r="9" fill="#FAFBFC" />
        <circle cx="47" cy="64" r="10" fill="none" stroke="#C9A25E" strokeWidth="5.5" />
      </svg>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ color: "#F2F3F5", fontSize: 88, fontWeight: 700, letterSpacing: "-0.03em" }}>
          Kilin
        </div>
        <div style={{ background: "#C9A25E", height: 3, marginTop: 20, width: 56 }} />
        <div style={{ color: "#B4B8C0", fontSize: 34, letterSpacing: "-0.01em", marginTop: 22 }}>
          Deterministic workflows for coding agents
        </div>
        <div style={{ color: "#6E737D", fontSize: 22, marginTop: 26 }}>docs.kilin.space</div>
      </div>
    </div>,
    size,
  );
}
