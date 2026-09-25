import type { ReactNode } from 'react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';

type Props = {
    /** The element that opens the dialog (rendered with `asChild`). */
    trigger: ReactNode;
    title: string;
    description?: ReactNode;
    confirmLabel?: string;
    destructive?: boolean;
    processing?: boolean;
    /** Called when confirmed; call `close()` once the action succeeded. */
    onConfirm: (close: () => void) => void;
};

/** A small "are you sure?" dialog. */
export function ConfirmDialog({
    trigger,
    title,
    description,
    confirmLabel = 'Confirm',
    destructive = false,
    processing = false,
    onConfirm,
}: Props) {
    const [open, setOpen] = useState(false);

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>{trigger}</DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    {description && (
                        <DialogDescription>{description}</DialogDescription>
                    )}
                </DialogHeader>
                <DialogFooter className="gap-2">
                    <DialogClose asChild>
                        <Button variant="secondary" disabled={processing}>
                            Cancel
                        </Button>
                    </DialogClose>
                    <Button
                        variant={destructive ? 'destructive' : 'default'}
                        disabled={processing}
                        onClick={() => onConfirm(() => setOpen(false))}
                    >
                        {processing && <Spinner />}
                        {confirmLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
