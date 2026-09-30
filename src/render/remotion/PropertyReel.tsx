import React from "react";
import { AbsoluteFill, Audio, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { captionChunks, type ReelProps, type Segment } from "../props";

const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const BRAND = "#0f766e"; // Property Potential teal

const Motion: React.FC<{ seg: Segment }> = ({ seg }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const total = Math.max(1, seg.durationSec * fps);
  const p = Math.min(1, frame / total);
  let scale = 1.08;
  // Pans move the crop window across the photo, so a landscape shot is seen edge to edge.
  let pos = 50;
  switch (seg.motion) {
    case "push_in":
      scale = interpolate(p, [0, 1], [1.05, 1.18]);
      break;
    case "pull_out":
      scale = interpolate(p, [0, 1], [1.18, 1.05]);
      break;
    case "pan_left":
      scale = 1.04;
      pos = interpolate(p, [0, 1], [85, 15]);
      break;
    case "pan_right":
      scale = 1.04;
      pos = interpolate(p, [0, 1], [15, 85]);
      break;
    default:
      scale = 1;
  }
  // Short cross-fade in, so cuts don't jump.
  const opacity = interpolate(frame, [0, 6], [0, 1], { extrapolateRight: "clamp" });
  const style: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover", objectPosition: `${pos}% 50%`, transform: `scale(${scale})` };
  return (
    <AbsoluteFill style={{ opacity, backgroundColor: "black" }}>
      {seg.kind === "video" ? <OffthreadVideo src={staticFile(seg.src)} muted style={style} /> : <Img src={staticFile(seg.src)} style={style} />}
      {/* Darken the top and bottom so captions and overlays stay readable. */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.6) 100%)" }} />
      {seg.aiLabel ? (
        <div style={{ position: "absolute", top: 72, right: 48, padding: "10px 20px", borderRadius: 999, background: "rgba(0,0,0,0.6)", color: "white", fontFamily: FONT, fontSize: 30, fontWeight: 600 }}>
          AI-generated
        </div>
      ) : null}
      {seg.onScreen ? (
        <div
          style={{
            position: "absolute",
            top: 200,
            left: 60,
            padding: "18px 30px",
            borderRadius: 18,
            background: BRAND,
            color: "white",
            fontFamily: FONT,
            fontSize: 56,
            fontWeight: 800,
            transform: `translateY(${interpolate(frame, [0, 8], [30, 0], { extrapolateRight: "clamp" })}px)`,
            opacity: interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" }),
          }}
        >
          {seg.onScreen}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const Captions: React.FC<{ words: ReelProps["words"] }> = ({ words }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const chunk = captionChunks(words).find((c) => t >= c.start - 0.05 && t <= c.end + 0.15);
  if (!chunk) return null;
  return (
    <div style={{ position: "absolute", left: 60, right: 60, bottom: 460, textAlign: "center", fontFamily: FONT, fontWeight: 900, fontSize: 84, lineHeight: 1.1, textTransform: "uppercase" }}>
      {chunk.words.map((w, i) => {
        const next = chunk.words[i + 1];
        const active = t >= w.start && (next ? t < next.start : t <= w.end + 0.15);
        return (
          <span key={i} style={{ color: active ? "#facc15" : "white", WebkitTextStroke: "3px black", paintOrder: "stroke fill", textShadow: "0 6px 18px rgba(0,0,0,0.6)", marginRight: 22 }}>
            {w.word}
          </span>
        );
      })}
    </div>
  );
};

const EndCard: React.FC<{ headline: string; sub: string }> = ({ headline, sub }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 220, opacity }}>
      <div style={{ background: "rgba(255,255,255,0.95)", borderRadius: 32, padding: "36px 56px", textAlign: "center", fontFamily: FONT }}>
        <div style={{ color: BRAND, fontSize: 64, fontWeight: 900 }}>{headline}</div>
        <div style={{ color: "#111827", fontSize: 38, fontWeight: 600, marginTop: 8 }}>{sub}</div>
      </div>
    </AbsoluteFill>
  );
};

export const PropertyReel: React.FC<ReelProps> = ({ segments, words, endCard, fps }) => {
  const f = (sec: number) => Math.round(sec * fps);
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {segments.map((seg) => (
        <Sequence key={seg.lineId} from={f(seg.fromSec)} durationInFrames={Math.max(1, f(seg.durationSec))}>
          <Motion seg={seg} />
        </Sequence>
      ))}
      {segments.map((seg) => (
        <Sequence key={`a-${seg.lineId}`} from={f(seg.voiceFromSec)}>
          <Audio src={staticFile(seg.voiceSrc)} />
        </Sequence>
      ))}
      <Captions words={words} />
      <Sequence from={f(endCard.fromSec)}>
        <EndCard headline={endCard.headline} sub={endCard.sub} />
      </Sequence>
    </AbsoluteFill>
  );
};

export const Thumbnail: React.FC<ReelProps> = ({ thumbnail }) => (
  <AbsoluteFill style={{ backgroundColor: "black" }}>
    <Img src={staticFile(thumbnail.imageSrc)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0) 35%, rgba(0,0,0,0.75) 100%)" }} />
    <div style={{ position: "absolute", left: 70, right: 70, bottom: 360, fontFamily: FONT, color: "white", fontSize: 128, fontWeight: 900, lineHeight: 1.0, textTransform: "uppercase", textShadow: "0 8px 24px rgba(0,0,0,0.7)" }}>
      {thumbnail.text}
    </div>
    {thumbnail.price ? (
      <div style={{ position: "absolute", left: 70, bottom: 230, padding: "14px 28px", borderRadius: 18, background: BRAND, color: "white", fontFamily: FONT, fontSize: 64, fontWeight: 800 }}>
        {thumbnail.price}
      </div>
    ) : null}
  </AbsoluteFill>
);
