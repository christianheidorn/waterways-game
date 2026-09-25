import { useId } from 'react';
import { cn } from '@/lib/utils';

function hexToRgb(hex: string): [number, number, number] {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);

    if (!m) {
        return [0.5, 0.5, 0.5];
    }

    return [
        Number.parseInt(m[1], 16) / 255,
        Number.parseInt(m[2], 16) / 255,
        Number.parseInt(m[3], 16) / 255,
    ];
}

type Props = {
    color: string;
    colorSecondary: string;
    /** 0-1: how strongly the two colours are mixed. */
    variation: number;
    /** World metres per noise repetition. */
    noiseScale: number;
    /** 0-2: surface grain. */
    bump?: number;
    textureUrl?: string | null;
    seed?: number;
    className?: string;
};

/**
 * Live preview of a terrain material: the primary colour broken up by noise blotches of the
 * secondary colour (SVG turbulence), with some grain for bump. Approximates the in-game shader.
 */
export function MaterialSwatch({
    color,
    colorSecondary,
    variation,
    noiseScale,
    bump = 0.4,
    textureUrl,
    seed = 1,
    className,
}: Props) {
    const rawId = useId();
    const id = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
    const [r, g, b] = hexToRgb(colorSecondary);
    // Assume the swatch shows roughly 24 m of terrain across ~200 px.
    const frequency = Math.min(
        0.5,
        Math.max(0.003, 1 / (Math.max(0.1, noiseScale) * 8)),
    );

    return (
        <div
            className={cn('relative overflow-hidden', className)}
            style={{ backgroundColor: color }}
            aria-hidden="true"
        >
            {textureUrl && (
                <div
                    className="absolute inset-0 bg-repeat opacity-70 mix-blend-multiply"
                    style={{
                        backgroundImage: `url("${textureUrl}")`,
                        backgroundSize: '64px 64px',
                    }}
                />
            )}
            <svg className="absolute inset-0 size-full">
                <filter
                    id={`${id}-blotch`}
                    x="0"
                    y="0"
                    width="100%"
                    height="100%"
                >
                    <feTurbulence
                        type="fractalNoise"
                        baseFrequency={frequency}
                        numOctaves={3}
                        seed={seed}
                    />
                    <feColorMatrix
                        type="matrix"
                        values={`0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} 3.2 0 0 0 -1.3`}
                    />
                </filter>
                <filter
                    id={`${id}-grain`}
                    x="0"
                    y="0"
                    width="100%"
                    height="100%"
                >
                    <feTurbulence
                        type="fractalNoise"
                        baseFrequency={0.9}
                        numOctaves={2}
                        seed={seed + 7}
                    />
                    <feColorMatrix type="saturate" values="0" />
                </filter>
                <rect
                    width="100%"
                    height="100%"
                    filter={`url(#${id}-blotch)`}
                    opacity={Math.min(1, 0.25 + variation * 0.9)}
                />
                <rect
                    width="100%"
                    height="100%"
                    filter={`url(#${id}-grain)`}
                    opacity={Math.min(0.5, bump * 0.25)}
                    style={{ mixBlendMode: 'soft-light' }}
                />
            </svg>
        </div>
    );
}
