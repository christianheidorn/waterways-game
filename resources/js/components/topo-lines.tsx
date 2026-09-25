import { cn } from '@/lib/utils';

type Props = {
    /** Varies the shape of the contours; any integer works. */
    seed?: number;
    className?: string;
};

function random(seed: number): () => number {
    let s = seed % 2147483647 || 1;

    return () => {
        s = (s * 16807) % 2147483647;

        return (s - 1) / 2147483646;
    };
}

function contour(
    cx: number,
    cy: number,
    radius: number,
    phases: number[],
    amplitude: number,
): string {
    const steps = 48;
    const points: string[] = [];

    for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const r =
            radius *
            (1 +
                amplitude *
                    (Math.sin(a * 2 + phases[0]) * 0.5 +
                        Math.sin(a * 3 + phases[1]) * 0.3 +
                        Math.sin(a * 5 + phases[2]) * 0.2));
        const x = cx + Math.cos(a) * r * 1.35;
        const y = cy + Math.sin(a) * r;
        points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
    }

    return `${points.join(' ')}Z`;
}

/**
 * Decorative topographic contour lines, used as placeholder art for maps without a thumbnail.
 * Draws with `currentColor`.
 */
export function TopoLines({ seed = 7, className }: Props) {
    const rand = random(seed * 9301 + 49297);
    const peaks = Array.from({ length: 3 }, () => ({
        cx: 40 + rand() * 320,
        cy: 30 + rand() * 165,
        rings: 4 + Math.floor(rand() * 5),
        phases: [rand() * 6.28, rand() * 6.28, rand() * 6.28],
    }));

    return (
        <svg
            viewBox="0 0 400 225"
            preserveAspectRatio="xMidYMid slice"
            fill="none"
            stroke="currentColor"
            aria-hidden="true"
            className={cn('pointer-events-none', className)}
        >
            {peaks.map((peak, p) =>
                Array.from({ length: peak.rings }, (_, i) => (
                    <path
                        key={`${p}-${i}`}
                        d={contour(
                            peak.cx,
                            peak.cy,
                            10 + i * 14,
                            peak.phases,
                            0.18 + i * 0.015,
                        )}
                        strokeWidth={i % 4 === 3 ? 1.4 : 0.8}
                        opacity={0.9 - i * 0.06}
                    />
                )),
            )}
        </svg>
    );
}
