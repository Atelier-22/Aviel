// Astraeya — the mark, the logo and the wordmark.
//
// The logo is inline SVG drawn from logo-paths.ts, which is generated from the
// astraeya-adaptive-*.svg artwork. The neutral parts use currentColor, set to
// --text-primary, so they follow the app's light and dark theme. The blue parts
// use the fixed --brand colour, never the accent preference: a logo that
// changes colour with a setting stops reading as a logo.

import {
  HORIZONTAL_ICON_TRANSFORM,
  HORIZONTAL_VIEWBOX,
  HORIZONTAL_WORD_PATHS,
  ICON_PATHS,
  ICON_TRANSFORM,
  ICON_VIEWBOX,
  type LogoPath,
} from "./logo-paths";

const TAGLINE = "Think · Decide · Grow";

const HORIZONTAL_RATIO = 977 / 300;

function Paths({ paths }: { paths: LogoPath[] }) {
  return (
    <>
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fillRule={p.evenodd ? "evenodd" : undefined}
          style={{ fill: p.tone === "brand" ? "var(--brand, #1e6bff)" : "currentColor" }}
        />
      ))}
    </>
  );
}

/**
 * The name as type: "Astra" in the surrounding text colour, "eya" in the fixed
 * brand blue. Inherits size and weight from its parent, so any call site can
 * style it like ordinary text.
 */
export function AstraeyaWordmark({ className = "" }: { className?: string }) {
  return (
    <span className={className} aria-label="Astraeya">
      <span aria-hidden="true">
        Astra<span style={{ color: "var(--brand)" }}>eya</span>
      </span>
    </span>
  );
}

/** The mark on its own, for places only a square fits. */
export function AstraeyaIcon({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox={ICON_VIEWBOX}
      width={size}
      height={size}
      role="img"
      aria-label="Astraeya"
      className={`shrink-0 ${className}`}
      style={{ color: "var(--text-primary)" }}
    >
      <g transform={ICON_TRANSFORM}>
        <Paths paths={ICON_PATHS} />
      </g>
    </svg>
  );
}

/** Mark and name side by side: the main logo. `height` sets the whole lockup. */
export function AstraeyaLockupInline({
  height = 28,
  className = "",
  showTagline = false,
}: {
  height?: number;
  className?: string;
  showTagline?: boolean;
}) {
  const logo = (
    <svg
      viewBox={HORIZONTAL_VIEWBOX}
      width={Math.round(height * HORIZONTAL_RATIO)}
      height={height}
      role="img"
      aria-label="Astraeya"
      className={showTagline ? "shrink-0" : `shrink-0 ${className}`}
      style={{ color: "var(--text-primary)" }}
    >
      <g transform={HORIZONTAL_ICON_TRANSFORM}>
        <Paths paths={ICON_PATHS} />
      </g>
      <Paths paths={HORIZONTAL_WORD_PATHS} />
    </svg>
  );

  if (!showTagline) return logo;

  return (
    <span className={`inline-flex flex-col items-start leading-none ${className}`}>
      {logo}
      <Tagline size={Math.max(7, Math.round(height * 0.22))} marginTop={height * 0.16} />
    </span>
  );
}

/**
 * The logo with the strapline beneath, for the login, register and empty chat
 * screens. Below about 36px the strapline stops being readable and is dropped
 * rather than rendered as a grey smear.
 */
export function AstraeyaLockup({
  height = 64,
  width,
  className = "",
  showTagline = true,
  align = "center",
}: {
  height?: number;
  width?: number;
  className?: string;
  showTagline?: boolean;
  align?: "left" | "center";
}) {
  const withTagline = showTagline && height >= 36;
  const centered = align === "center";

  return (
    <span
      className={`inline-flex select-none flex-col leading-none ${
        centered ? "items-center text-center" : "items-start"
      } ${className}`}
      style={width ? { maxWidth: width } : undefined}
    >
      <AstraeyaLockupInline height={height} />
      {withTagline && (
        <Tagline
          size={Math.max(8, Math.round(height * 0.17))}
          marginTop={height * 0.28}
          centered={centered}
        />
      )}
    </span>
  );
}

function Tagline({
  size,
  marginTop,
  centered = false,
}: {
  size: number;
  marginTop: number;
  centered?: boolean;
}) {
  return (
    <span
      style={{
        fontSize: size,
        letterSpacing: "0.3em",
        // Tracking adds space after the final letter too, which throws the
        // block off-centre against the logo above it.
        marginRight: centered ? "-0.3em" : undefined,
        marginTop,
        textTransform: "uppercase",
        color: "var(--text-secondary)",
        whiteSpace: "nowrap",
      }}
    >
      {TAGLINE}
    </span>
  );
}

/** Where the blue ring sits in the mark's own coordinates: its centre of rotation. */
const RING_CENTRE = "511.4 527.9";

/**
 * The mark, which can come alive while Astraeya is thinking: the blue ring
 * orbits around the centre, tilting up and down as it goes, while the dark
 * stroke stays still. At rest it is just the logo.
 */
export function AstraeyaMark({
  size = 20,
  thinking = false,
  className = "",
  label,
}: {
  size?: number;
  thinking?: boolean;
  className?: string;
  label?: string;
}) {
  const ink = ICON_PATHS.filter((p) => p.tone !== "brand");
  const ring = ICON_PATHS.filter((p) => p.tone === "brand");
  return (
    <svg
      viewBox={ICON_VIEWBOX}
      width={size}
      height={size}
      role="img"
      aria-label={label ?? (thinking ? "Astraeya is thinking" : "Astraeya")}
      className={`shrink-0 ${thinking ? "astraeya-thinking" : ""} ${className}`}
      style={{ color: "var(--text-primary)" }}
    >
      <g transform={ICON_TRANSFORM}>
        <g className="astraeya-ring">
          {thinking && (
            <>
              <animateTransform
                attributeName="transform"
                type="rotate"
                values={`0 ${RING_CENTRE};180 ${RING_CENTRE};360 ${RING_CENTRE}`}
                keyTimes="0;0.5;1"
                dur="1.6s"
                repeatCount="indefinite"
              />
            </>
          )}
          <g className="astraeya-ring-tilt">
            <Paths paths={ring} />
          </g>
        </g>
        <Paths paths={ink} />
      </g>
    </svg>
  );
}
