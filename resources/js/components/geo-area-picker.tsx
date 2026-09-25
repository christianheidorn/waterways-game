import 'leaflet/dist/leaflet.css';
import type {
    LatLngBoundsExpression,
    Map as LeafletMap,
    Marker,
    Rectangle,
} from 'leaflet';
import L from 'leaflet';
import { Crosshair, LoaderCircle, MapPin, Search } from 'lucide-react';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
    formatCoordinate,
    formatKm,
    formatMetresPerSample,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import type { MapBounds } from '@/types';

export type GeoArea = {
    lat: number;
    lng: number;
    /** Edge length of the square area in metres. */
    size: number;
};

/** Lake Bled, Slovenia — mountains, a lake and an island. */
export const DEFAULT_GEO_AREA: GeoArea = {
    lat: 46.3625,
    lng: 14.0936,
    size: 4096,
};

export const GEO_AREA_SIZES = [1024, 2048, 4096, 8192, 16384];

const METRES_PER_DEGREE = 111_320;

/** A true square (in metres) around the centre, as Leaflet bounds. */
export function squareBounds(
    area: GeoArea,
): [[number, number], [number, number]] {
    const halfLat = area.size / 2 / METRES_PER_DEGREE;
    const halfLng =
        area.size /
        2 /
        (METRES_PER_DEGREE *
            Math.max(0.01, Math.cos((area.lat * Math.PI) / 180)));

    return [
        [area.lat - halfLat, area.lng - halfLng],
        [area.lat + halfLat, area.lng + halfLng],
    ];
}

function createBaseLayers(): Record<string, L.TileLayer> {
    return {
        OpenStreetMap: L.tileLayer(
            'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            {
                maxZoom: 19,
                attribution:
                    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            },
        ),
        Satellite: L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            {
                maxZoom: 19,
                attribution:
                    'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
            },
        ),
        Topographic: L.tileLayer(
            'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
            {
                maxZoom: 17,
                subdomains: 'abc',
                attribution:
                    'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
            },
        ),
    };
}

const SELECTION_STYLE: L.PathOptions = {
    color: '#0ea5e9',
    weight: 2,
    fillColor: '#0ea5e9',
    fillOpacity: 0.12,
    dashArray: '6 4',
};

function centreIcon(): L.DivIcon {
    return L.divIcon({
        className: '',
        html: '<div class="size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-sky-500 shadow-[0_0_0_2px_rgba(14,165,233,0.45),0_2px_6px_rgba(0,0,0,0.4)] cursor-grab active:cursor-grabbing"></div>',
        iconSize: [0, 0],
        iconAnchor: [0, 0],
    });
}

type NominatimResult = {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
};

type Props = {
    value: GeoArea | null;
    onChange: (value: GeoArea) => void;
    /** Heightmap resolution, used to show the resulting metres per sample. */
    resolution?: number;
    sizes?: number[];
    className?: string;
};

/**
 * Pick a square real-world area on a slippy map: drag the centre marker, click the map,
 * search for a place, and choose the edge length.
 */
export function GeoAreaPicker({
    value,
    onChange,
    resolution,
    sizes = GEO_AREA_SIZES,
    className,
}: Props) {
    const area = value ?? DEFAULT_GEO_AREA;
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<LeafletMap | null>(null);
    const rectRef = useRef<Rectangle | null>(null);
    const markerRef = useRef<Marker | null>(null);
    const searchId = useId();

    const [query, setQuery] = useState('');
    const [searching, setSearching] = useState(false);
    const [results, setResults] = useState<NominatimResult[] | null>(null);
    const [searchError, setSearchError] = useState<string | null>(null);

    const emit = useEffectEvent((next: GeoArea) => onChange(next));
    const currentArea = useEffectEvent(() => area);
    const hasValue = useEffectEvent(() => value !== null);

    // Create the Leaflet map once.
    useEffect(() => {
        if (typeof window === 'undefined' || !containerRef.current) {
            return;
        }

        const initial = currentArea();
        const map = L.map(containerRef.current, {
            zoomControl: true,
            attributionControl: true,
            worldCopyJump: true,
        });
        const baseLayers = createBaseLayers();
        baseLayers['OpenStreetMap'].addTo(map);
        L.control
            .layers(baseLayers, undefined, { position: 'topright' })
            .addTo(map);
        L.control.scale({ imperial: false }).addTo(map);

        const rect = L.rectangle(squareBounds(initial), {
            ...SELECTION_STYLE,
            interactive: false,
        }).addTo(map);
        const marker = L.marker([initial.lat, initial.lng], {
            icon: centreIcon(),
            draggable: true,
            autoPan: true,
            keyboard: true,
            title: 'Drag to move the selected area',
        }).addTo(map);

        marker.on('drag', () => {
            const p = marker.getLatLng();
            rect.setBounds(
                squareBounds({ ...currentArea(), lat: p.lat, lng: p.lng }),
            );
        });
        marker.on('dragend', () => {
            const p = marker.getLatLng();
            emit({ ...currentArea(), lat: p.lat, lng: p.lng });
        });
        map.on('click', (e: L.LeafletMouseEvent) => {
            emit({ ...currentArea(), lat: e.latlng.lat, lng: e.latlng.lng });
        });

        map.fitBounds(squareBounds(initial), { padding: [32, 32] });

        mapRef.current = map;
        rectRef.current = rect;
        markerRef.current = marker;

        const observer = new ResizeObserver(() => map.invalidateSize());
        observer.observe(containerRef.current);

        if (!hasValue()) {
            emit(initial);
        }

        return () => {
            observer.disconnect();
            map.remove();
            mapRef.current = null;
            rectRef.current = null;
            markerRef.current = null;
        };
    }, []);

    // Keep the selection in sync with the value.
    useEffect(() => {
        const bounds = squareBounds({
            lat: area.lat,
            lng: area.lng,
            size: area.size,
        });
        rectRef.current?.setBounds(bounds);
        markerRef.current?.setLatLng([area.lat, area.lng]);
    }, [area.lat, area.lng, area.size]);

    // Zoom to fit when the size changes.
    useEffect(() => {
        const map = mapRef.current;

        if (map) {
            map.fitBounds(squareBounds(currentArea()), {
                padding: [32, 32],
                animate: true,
            });
        }
    }, [area.size]);

    const applyViewCentre = () => {
        const centre = mapRef.current?.getCenter();

        if (centre) {
            onChange({
                ...area,
                lat: centre.lat,
                lng: L.Util.wrapNum(centre.lng, [-180, 180], true),
            });
        }
    };

    const search = async () => {
        const q = query.trim();

        if (!q) {
            return;
        }

        setSearching(true);
        setSearchError(null);

        try {
            const response = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`,
                { headers: { Accept: 'application/json' } },
            );

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = (await response.json()) as NominatimResult[];
            setResults(data);

            if (data.length === 1) {
                pick(data[0]);
            }
        } catch {
            setResults(null);
            setSearchError('Place search is unavailable right now.');
        } finally {
            setSearching(false);
        }
    };

    const pick = (result: NominatimResult) => {
        const lat = Number.parseFloat(result.lat);
        const lng = Number.parseFloat(result.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return;
        }

        const next = { ...area, lat, lng };
        setResults(null);
        onChange(next);
        mapRef.current?.flyToBounds(squareBounds(next), {
            padding: [32, 32],
            duration: 1.2,
        });
    };

    return (
        <div className={cn('grid gap-3', className)}>
            <div className="relative flex gap-2" role="search">
                <Label htmlFor={searchId} className="sr-only">
                    Search for a place
                </Label>
                <div className="relative flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        id={searchId}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search a place, e.g. Lake Bled"
                        className="pl-8"
                        autoComplete="off"
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                // Never submit a surrounding form.
                                e.preventDefault();
                                void search();
                            }

                            if (e.key === 'Escape') {
                                setResults(null);
                            }
                        }}
                    />
                </div>
                <Button
                    type="button"
                    variant="secondary"
                    disabled={searching}
                    onClick={() => void search()}
                >
                    {searching ? (
                        <LoaderCircle className="animate-spin" />
                    ) : (
                        <Search />
                    )}
                    <span className="hidden sm:inline">Search</span>
                </Button>

                {results !== null && (
                    <div className="absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
                        {results.length === 0 ? (
                            <p className="px-3 py-2 text-sm text-muted-foreground">
                                No places found.
                            </p>
                        ) : (
                            <ul className="max-h-64 overflow-y-auto py-1">
                                {results.map((result) => (
                                    <li key={result.place_id}>
                                        <button
                                            type="button"
                                            onClick={() => pick(result)}
                                            className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
                                        >
                                            <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                                            <span className="line-clamp-2">
                                                {result.display_name}
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <button
                            type="button"
                            onClick={() => setResults(null)}
                            className="w-full border-t px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent"
                        >
                            Close
                        </button>
                    </div>
                )}
            </div>
            {searchError && (
                <p className="text-sm text-amber-600 dark:text-amber-400">
                    {searchError}
                </p>
            )}

            <div className="relative isolate overflow-hidden rounded-xl border bg-muted shadow-xs">
                <div
                    ref={containerRef}
                    className="h-[420px] w-full cursor-crosshair [&_.leaflet-control-attribution]:text-[10px] [&_.leaflet-control-layers]:rounded-md! [&_.leaflet-control-layers]:border-none! [&_.leaflet-control-layers]:shadow-md! [&_.leaflet-control-zoom]:overflow-hidden [&_.leaflet-control-zoom]:rounded-md! [&_.leaflet-control-zoom]:border-none! [&_.leaflet-control-zoom]:shadow-md!"
                    role="application"
                    aria-label="Map for choosing the real-world area. Click to move the selection or drag the centre marker."
                />
                <div className="pointer-events-none absolute bottom-2 left-2 z-[1000] rounded-md bg-background/90 px-2 py-1 text-xs font-medium shadow-sm backdrop-blur">
                    {formatKm(area.size)} × {formatKm(area.size)}
                </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                    <span
                        className="text-sm font-medium"
                        id={`${searchId}-size`}
                    >
                        Area
                    </span>
                    <ToggleGroup
                        type="single"
                        variant="outline"
                        size="sm"
                        value={String(area.size)}
                        onValueChange={(v) =>
                            v && onChange({ ...area, size: Number(v) })
                        }
                        aria-labelledby={`${searchId}-size`}
                    >
                        {sizes.map((size) => (
                            <ToggleGroupItem
                                key={size}
                                value={String(size)}
                                className="px-2.5 tabular-nums"
                                aria-label={`${formatKm(size)} square`}
                            >
                                {Math.round(size / 1024)} km
                            </ToggleGroupItem>
                        ))}
                    </ToggleGroup>
                </div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={applyViewCentre}
                >
                    <Crosshair />
                    Use view centre
                </Button>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                    Centre {formatCoordinate(area.lat, 'lat')},{' '}
                    {formatCoordinate(area.lng, 'lng')}
                </span>
                <span>Edge {formatKm(area.size)}</span>
                {resolution && (
                    <span>
                        {resolution} × {resolution} samples ·{' '}
                        {formatMetresPerSample(area.size, resolution)} per
                        sample
                    </span>
                )}
            </div>
        </div>
    );
}

/** A small, non-interactive map showing a map's real-world footprint. */
export function GeoAreaPreview({
    bounds,
    className,
}: {
    bounds: MapBounds;
    className?: string;
}) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (typeof window === 'undefined' || !containerRef.current) {
            return;
        }

        const leafletBounds: LatLngBoundsExpression = [
            [bounds.south, bounds.west],
            [bounds.north, bounds.east],
        ];
        const map = L.map(containerRef.current, {
            zoomControl: false,
            attributionControl: true,
            dragging: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
            touchZoom: false,
        });
        createBaseLayers()['OpenStreetMap'].addTo(map);
        L.rectangle(leafletBounds, {
            ...SELECTION_STYLE,
            interactive: false,
        }).addTo(map);
        map.fitBounds(leafletBounds, { padding: [16, 16] });

        const observer = new ResizeObserver(() => {
            map.invalidateSize();
            map.fitBounds(leafletBounds, { padding: [16, 16] });
        });
        observer.observe(containerRef.current);

        return () => {
            observer.disconnect();
            map.remove();
        };
    }, [bounds.south, bounds.west, bounds.north, bounds.east]);

    return (
        <div
            className={cn(
                'relative isolate overflow-hidden rounded-lg border bg-muted',
                className,
            )}
        >
            <div
                ref={containerRef}
                className="h-full min-h-40 w-full [&_.leaflet-control-attribution]:text-[9px]"
                aria-label="Map footprint"
                role="img"
            />
        </div>
    );
}
