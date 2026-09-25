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
import maps from '@/routes/maps';

type CreateMapForm = TerrainFormData & {
    name: string;
    description: string;
};

export default function CreateMap({ resolutions }: { resolutions: number[] }) {
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
        seed: null,
        ...SHAPING_DEFAULTS,
    });

    const submit = (e: FormEvent) => {
        e.preventDefault();

        form.transform((data) => ({
            ...data,
            description: data.description.trim() || null,
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
