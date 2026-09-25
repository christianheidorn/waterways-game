import { usePoll } from '@inertiajs/react';
import { useEffect } from 'react';

/**
 * Reloads the given props every `interval` ms while `pending` is true
 * (e.g. while terrain is being generated) and stops as soon as it is not.
 */
export function usePendingPoll(
    pending: boolean,
    only: string[],
    interval = 2000,
): void {
    const { start, stop } = usePoll(
        interval,
        { only },
        { autoStart: false, keepAlive: false },
    );

    useEffect(() => {
        if (pending) {
            start();
        } else {
            stop();
        }
    }, [pending, start, stop]);
}
