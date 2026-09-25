import AppLogoIcon from '@/components/app-logo-icon';

export default function AppLogo() {
    return (
        <>
            <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-gradient-to-br from-sky-500 to-teal-600 text-white shadow-sm">
                <AppLogoIcon className="size-5" />
            </div>
            <div className="ml-1 grid flex-1 text-left text-sm">
                <span className="truncate leading-tight font-semibold">
                    Waterways
                </span>
                <span className="truncate text-xs text-muted-foreground">
                    Creator Studio
                </span>
            </div>
        </>
    );
}
