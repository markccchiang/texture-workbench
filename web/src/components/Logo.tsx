// The application mark: a field of texture with a region of interest on it (web/public/logo.svg)

/** Opacity of each cell of the 4 × 4 field, brightest along the diagonal, as in a co-occurrence matrix */
const TONES = [
  [0.92, 0.3, 0.55, 0.22],
  [0.3, 0.76, 0.28, 0.5],
  [0.55, 0.28, 0.86, 0.3],
  [0.22, 0.5, 0.3, 0.68],
];

const CELL = 11.5;
const GAP = 2.5;
const OFFSET = 5.25;

export function LogoMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Texture Workbench" style={{ display: 'block', flex: 'none' }}>
      <rect width="64" height="64" rx="14" fill="#142433" />
      <g fill="#4DABF7">
        {TONES.flatMap((row, r) =>
          row.map((tone, c) => (
            <rect
              key={`${r}-${c}`}
              x={OFFSET + c * (CELL + GAP)}
              y={OFFSET + r * (CELL + GAP)}
              width={CELL}
              height={CELL}
              rx={CELL * 0.16}
              opacity={tone}
            />
          )),
        )}
      </g>
      <rect x="16.5" y="16.5" width="31" height="31" rx="6" fill="#0E1A24" fillOpacity="0.42" stroke="#29D3EE" strokeWidth="4.6" />
    </svg>
  );
}
