import { Head, useForm } from '@inertiajs/react';
import { RotateCcw } from 'lucide-react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import Heading from '@/components/heading';
import { SettingsForm } from '@/components/settings-form';
import { Button } from '@/components/ui/button';
import gameSettings from '@/routes/game-settings';
import type { SettingGroup, SettingValues } from '@/types';

type Props = {
    group: SettingGroup;
    values: SettingValues;
    groups: { key: string; title: string }[];
};

export default function GameSettingsEdit({ group, values }: Props) {
    const resetForm = useForm({});

    return (
        <>
            <Head title={`${group.title} settings`} />

            <h1 className="sr-only">{group.title} settings</h1>

            <div className="space-y-6">
                <Heading
                    variant="small"
                    title={`${group.title} settings`}
                    description={group.description}
                />

                <SettingsForm
                    group={group}
                    values={values}
                    action={gameSettings.update(group.key)}
                    actions={
                        <ConfirmDialog
                            trigger={
                                <Button type="button" variant="outline">
                                    <RotateCcw />
                                    Reset to defaults
                                </Button>
                            }
                            title={`Reset ${group.title.toLowerCase()} settings?`}
                            description="Every value in this group goes back to its default. This applies to all maps."
                            confirmLabel="Reset"
                            destructive
                            processing={resetForm.processing}
                            onConfirm={(close) =>
                                resetForm.submit(
                                    gameSettings.reset(group.key),
                                    {
                                        preserveScroll: true,
                                        onSuccess: close,
                                    },
                                )
                            }
                        />
                    }
                />
            </div>
        </>
    );
}

GameSettingsEdit.layout = (props: Props) => ({
    breadcrumbs: [
        {
            title: 'Settings',
            href: gameSettings.edit('player'),
        },
        {
            title: props.group.title,
            href: gameSettings.edit(props.group.key),
        },
    ],
});
