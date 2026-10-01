/**
 * Alpha coverage checks for cut-out foliage textures (cards, impostor atlases): a texture whose
 * background is still opaque draws its plant as a black (or coloured) box. Used by the baker after
 * every bake and by the game once per loaded texture (see world/foliage/alphaCheck.ts).
 *
 * Layouts:
 * - 'card': one image of a plant trimmed to its bounds (AI / uploaded card assets);
 * - 'views': side views next to each other (crossed-card impostors, Impostor.ts / older bakes);
 * - 'octahedral': frames × frames views of the model's bounding sphere (FoliageBaker). A silhouette
 *   inside the sphere covers at most π/4 of its cell and never reaches the cell's corners.
 */
export type CoverageLayout = 'card' | 'views' | 'octahedral';

export type CoverageCell = {
    /** Fraction of texels with alpha ≥ 0.5 (what the alpha test keeps). */
    coverage: number;
    /** Same within the outer band of the cell. */
    border: number;
    /** Same outside the cell's inscribed circle. */
    outside: number;
};

export type CoverageReport = {
    layout: CoverageLayout;
    cols: number;
    rows: number;
    cells: CoverageCell[];
    /** Cells that look like an opaque box. */
    opaque: number[];
    /** Highest coverage of any cell (0-1). */
    worst: number;
    ok: boolean;
};

/**
 * Coverage per cell of an image (`stride` values per texel, alpha at `channel`, 0-255) split into
 * cols × rows equal cells.
 */
export function measureCoverage(
    data: ArrayLike<number>,
    width: number,
    height: number,
    layout: CoverageLayout,
    cols = 1,
    rows = 1,
    stride = 4,
    channel = 3,
): CoverageReport {
    const cells: CoverageCell[] = [];
    const cw = width / cols;
    const ch = height / rows;

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const x0 = Math.round(c * cw);
            const x1 = Math.round((c + 1) * cw);
            const y0 = Math.round(r * ch);
            const y1 = Math.round((r + 1) * ch);
            const band = Math.max(
                1,
                Math.round(Math.min(x1 - x0, y1 - y0) * 0.03),
            );
            const cx = (x0 + x1) / 2;
            const cy = (y0 + y1) / 2;
            const rx = (x1 - x0) / 2;
            const ry = (y1 - y0) / 2;
            let total = 0;
            let covered = 0;
            let ring = 0;
            let ringCovered = 0;
            let out = 0;
            let outCovered = 0;

            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const opaque =
                        data[(y * width + x) * stride + channel] >= 128;
                    total++;
                    covered += opaque ? 1 : 0;

                    if (
                        x < x0 + band ||
                        x >= x1 - band ||
                        y < y0 + band ||
                        y >= y1 - band
                    ) {
                        ring++;
                        ringCovered += opaque ? 1 : 0;
                    }

                    const dx = (x + 0.5 - cx) / rx;
                    const dy = (y + 0.5 - cy) / ry;

                    if (dx * dx + dy * dy > 1.05) {
                        out++;
                        outCovered += opaque ? 1 : 0;
                    }
                }
            }

            cells.push({
                coverage: total ? covered / total : 0,
                border: ring ? ringCovered / ring : 0,
                outside: out ? outCovered / out : 0,
            });
        }
    }

    const opaque: number[] = [];

    cells.forEach((cell, i) => {
        if (isOpaqueCell(cell, layout)) {
            opaque.push(i);
        }
    });

    return {
        layout,
        cols,
        rows,
        cells,
        opaque,
        worst: Math.max(0, ...cells.map((c) => c.coverage)),
        ok: opaque.length === 0,
    };
}

/** Whether a cell looks like an opaque box rather than a cut-out plant. */
export function isOpaqueCell(
    cell: CoverageCell,
    layout: CoverageLayout,
): boolean {
    if (layout === 'octahedral') {
        // The silhouette stays inside the bounding sphere: opaque corners mean an opaque background.
        return cell.coverage > 0.9 || cell.outside > 0.3;
    }

    // A plant trimmed to its bounds touches them in places; a box fills them along every edge.
    return cell.coverage > 0.93 || (cell.coverage > 0.75 && cell.border > 0.6);
}

/** One line for warnings: "3 of 64 views ≥ 90 % opaque (worst 100 %)". */
export function describeCoverage(report: CoverageReport): string {
    const total = report.cols * report.rows;
    const pct = (v: number) => `${Math.round(v * 100)} %`;
    const what =
        total === 1
            ? `${pct(report.worst)} opaque`
            : `${report.opaque.length} of ${total} views opaque (worst ${pct(report.worst)})`;

    return report.ok
        ? `alpha coverage ok (worst ${pct(report.worst)})`
        : `${what}: the background was not cut out`;
}
