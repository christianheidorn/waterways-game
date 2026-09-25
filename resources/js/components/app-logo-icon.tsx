import type { SVGAttributes } from 'react';

/**
 * The Waterways mark: a river meandering through layered waves.
 * Uses `currentColor` for both stroke and fill so it can be tinted with text colour utilities.
 */
export default function AppLogoIcon(props: SVGAttributes<SVGElement>) {
    return (
        <svg
            viewBox="0 0 32 32"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            {...props}
        >
            <path d="M3 10.5c2.2-2 4.4-2 6.6 0s4.4 2 6.6 0 4.4-2 6.6 0 4.4 2 6.2 0" />
            <path
                d="M3 17c2.2-2 4.4-2 6.6 0s4.4 2 6.6 0 4.4-2 6.6 0 4.4 2 6.2 0"
                opacity={0.75}
            />
            <path
                d="M3 23.5c2.2-2 4.4-2 6.6 0s4.4 2 6.6 0 4.4-2 6.6 0 4.4 2 6.2 0"
                opacity={0.5}
            />
        </svg>
    );
}
