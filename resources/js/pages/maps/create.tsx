import { Head, Link, useForm } from '@inertiajs/react';
import { Sparkles } from 'lucide-react';
import type { FormEvent } from 'react';
import Heading from '@/components/heading';
import InputError from '@/components/input-error';
import type { TerrainFormData } from '@/components/terrain-source-fields';
import {
    SHAPING_DEFAULTS,
    TerrainSourceFields,
} from '@/components/terrain-source-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import maps from '@/routes/maps';

type CreateMapForm = TerrainFormData & {
    name: string;
    description: string;
    template: string | null;
    brief: string;
};

/** App\Support\MapTemplates::describe(). */
type MapTemplate = {
    key: string;
    name: string;
    summary: string;
    terrain: { size?: number; resolution?: number } & Record<string, unknown>;
};

export default function CreateMap({
    resolutions,
    templates = [],
}: {
    resolutions: number[];
    templates?: MapTemplate[];
}) {
    const form = useForm<CreateMapForm>({
        name: '',
        description: '',
        source: 'procedural',
        resolution: resolutions.includes(513)
            ? 513
            : resolutions[Math.floor(resolutions.length / 2)],
        size: 4096,
        center_lat: null,
        center_lng: null,
        height_scale: 1,
        import_water: true,
        use_landcover: true,
        seed: null,
        ...SHAPING_DEFAULTS,
        template: null,
        brief: '',
    });

    const pickTemplate = (template: MapTemplate | null) => {
        form.setData((prev) => ({
            ...prev,
            template: template?.key ?? null,
            ...(template
                ? {
                      source: 'procedural' as const,
                      size: Number(template.terrain.size ?? prev.size),
                      resolution: Number(
                          template.terrain.resolution ?? prev.resolution,
                      ),
                  }
                : {}),
        }));
    };

    const submit = (e: FormEvent) => {
        e.preventDefault();

        form.transform((data) => ({
            ...data,
            description: data.description.trim() || null,
            brief: data.brief.trim() || null,
            center_lat: data.source === 'real_world' ? data.center_lat : null,
            center_lng: data.source === 'real_world' ? data.center_lng : null,
            seed: data.source === 'procedural' ? data.seed : null,
        }));
        form.submit(maps.store());
    };

    return (
        <>
            <Head title="New map" />
            <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-4 sm:p-6">
                <Heading
                    title="New map"
                    description="Choose where your world comes from. Terrain is generated in the background — you can open the studio as soon as it is ready."
                />

                <form onSubmit={submit} className="space-y-10">
                    <section className="grid gap-6 rounded-xl border bg-card p-4 shadow-xs sm:p-6 md:grid-cols-2">
                        <div className="grid content-start gap-2">
                            <Label htmlFor="name">Name</Label>
                            <Input
                                id="name"
                                value={form.data.name}
                                onChange={(e) =>
                                    form.setData('name', e.target.value)
                                }
                                placeholder="e.g. Emerald Valley"
                                required
                                maxLength={120}
                                autoFocus
                                aria-invalid={
                                    form.errors.name ? true : undefined
                                }
                            />
                            <InputError message={form.errors.name} />
                        </div>
                        <div className="grid content-start gap-2">
                            <Label htmlFor="description">
                                Description{' '}
                                <span className="font-normal text-muted-foreground">
                                    (optional)
                                </span>
                            </Label>
                            <Textarea
                                id="description"
                                value={form.data.description}
                                onChange={(e) =>
                                    form.setData('description', e.target.value)
                                }
                                placeholder="What is this world about?"
                                maxLength={2000}
                                rows={2}
                            />
                            <InputError message={form.errors.description} />
                        </div>
                    </section>

                    {templates.length > 0 && (
                        <section className="grid gap-4 rounded-xl border bg-card p-4 shadow-xs sm:p-6">
                            <div className="grid gap-1">
                                <Label>Start from</Label>
                                <p className="text-sm text-muted-foreground">
                                    A template sets up terrain, biomes, weather
                                    and plants. You can still change everything
                                    afterwards.
                                </p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                {[null, ...templates].map((t) => (
                                    <button
                                        key={t?.key ?? 'blank'}
                                        type="button"
                                        onClick={() => pickTemplate(t)}
                                        className={cn(
                                            'rounded-lg border p-3 text-left text-sm transition-colors hover:bg-accent',
                                            form.data.template ===
                                                (t?.key ?? null) &&
                                                'border-primary ring-1 ring-primary',
                                        )}
                                    >
                                        <div className="font-medium">
                                            {t?.name ?? 'Blank'}
                                        </div>
                                        <div className="mt-1 text-muted-foreground">
                                            {t?.summary ??
                                                'Procedural or real-world terrain with the default layers.'}
                                        </div>
                                    </button>
                                ))}
                            </div>
                            <InputError message={form.errors.template} />
                            <div className="grid gap-2">
                                <Label htmlFor="brief">
                                    Describe the world for Claude{' '}
                                    <span className="font-normal text-muted-foreground">
                                        (optional)
                                    </span>
                                </Label>
                                <Textarea
                                    id="brief"
                                    value={form.data.brief}
                                    onChange={(e) =>
                                        form.setData('brief', e.target.value)
                                    }
                                    placeholder="e.g. A foggy fjord with a fishing village, pine forests and a waterfall. Claude picks this up as a request (MCP list_requests) and builds it."
                                    maxLength={4000}
                                    rows={3}
                                />
                                <InputError message={form.errors.brief} />
                            </div>
                        </section>
                    )}

                    <TerrainSourceFields
                        data={form.data}
                        onChange={(patch) =>
                            form.setData((prev) => ({ ...prev, ...patch }))
                        }
                        errors={form.errors}
                        resolutions={resolutions}
                    />

                    <div className="flex flex-col-reverse gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-end">
                        <Button variant="ghost" asChild>
                            <Link href={maps.index()}>Cancel</Link>
                        </Button>
                        <Button
                            type="submit"
                            size="lg"
                            disabled={form.processing}
                        >
                            {form.processing ? <Spinner /> : <Sparkles />}
                            Create map
                        </Button>
                    </div>
                </form>
            </div>
        </>
    );
}

CreateMap.layout = {
    breadcrumbs: [
        { title: 'Maps', href: maps.index() },
        { title: 'New map', href: maps.create() },
    ],
};
