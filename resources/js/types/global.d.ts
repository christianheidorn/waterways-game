declare module '@inertiajs/core' {
    export interface InertiaConfig {
        sharedPageProps: {
            name: string;
            sidebarOpen: boolean;
            [key: string]: unknown;
        };
    }
}

export {};
