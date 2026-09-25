/**
 * Keyboard / mouse state shared by the player controller, editor camera and tools.
 */
export class Input {
    readonly keys = new Set<string>();
    readonly buttons = new Set<number>();
    mouseX = 0;
    mouseY = 0;
    /** Normalised device coordinates of the pointer over the canvas. */
    ndcX = 0;
    ndcY = 0;
    deltaX = 0;
    deltaY = 0;
    wheel = 0;
    pointerOverCanvas = false;
    shift = false;
    ctrl = false;
    alt = false;

    private pressed = new Set<string>();
    private listeners: Array<() => void> = [];

    constructor(private readonly element: HTMLElement) {
        this.listen(window, 'keydown', (e) => {
            const ev = e as KeyboardEvent;

            if (this.isTyping(ev)) {
                return;
            }

            if (!this.keys.has(ev.code)) {
                this.pressed.add(ev.code);
            }

            this.keys.add(ev.code);
            this.updateModifiers(ev);
        });
        this.listen(window, 'keyup', (e) => {
            const ev = e as KeyboardEvent;
            this.keys.delete(ev.code);
            this.updateModifiers(ev);
        });
        this.listen(window, 'blur', () => {
            this.keys.clear();
            this.buttons.clear();
            this.shift = this.ctrl = this.alt = false;
        });
        this.listen(element, 'pointerdown', (e) => {
            const ev = e as PointerEvent;
            this.buttons.add(ev.button);
            this.updateModifiers(ev);
        });
        this.listen(window, 'pointerup', (e) => {
            this.buttons.delete((e as PointerEvent).button);
        });
        this.listen(window, 'pointermove', (e) => {
            const ev = e as PointerEvent;
            this.deltaX += ev.movementX;
            this.deltaY += ev.movementY;
            this.mouseX = ev.clientX;
            this.mouseY = ev.clientY;
            const rect = element.getBoundingClientRect();
            this.ndcX = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
            this.ndcY = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
            this.updateModifiers(ev);
        });
        this.listen(
            element,
            'pointerenter',
            () => (this.pointerOverCanvas = true),
        );
        this.listen(
            element,
            'pointerleave',
            () => (this.pointerOverCanvas = false),
        );
        this.listen(
            element,
            'wheel',
            (e) => {
                const ev = e as WheelEvent;
                ev.preventDefault();
                this.wheel += Math.sign(ev.deltaY);
            },
            { passive: false },
        );
        this.listen(element, 'contextmenu', (e) => e.preventDefault());
    }

    isDown(code: string): boolean {
        return this.keys.has(code);
    }

    /** True once per physical key press. */
    wasPressed(code: string): boolean {
        return this.pressed.has(code);
    }

    /** Call at the end of each frame. */
    endFrame(): void {
        this.deltaX = 0;
        this.deltaY = 0;
        this.wheel = 0;
        this.pressed.clear();
    }

    dispose(): void {
        for (const off of this.listeners) {
            off();
        }
    }

    private updateModifiers(e: KeyboardEvent | PointerEvent): void {
        this.shift = e.shiftKey;
        this.ctrl = e.ctrlKey || e.metaKey;
        this.alt = e.altKey;
    }

    private isTyping(e: KeyboardEvent): boolean {
        const target = e.target as HTMLElement | null;

        return (
            !!target &&
            (target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'SELECT' ||
                target.isContentEditable)
        );
    }

    private listen(
        target: EventTarget,
        type: string,
        fn: (e: Event) => void,
        options?: AddEventListenerOptions,
    ): void {
        target.addEventListener(type, fn, options);
        this.listeners.push(() =>
            target.removeEventListener(type, fn, options),
        );
    }
}
