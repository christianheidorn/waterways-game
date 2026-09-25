import { Link } from '@inertiajs/react';
import {
    Clapperboard,
    LayoutGrid,
    Map as MapIcon,
    Palette,
    SlidersHorizontal,
    Trees,
} from 'lucide-react';
import AppLogo from '@/components/app-logo';
import { NavMain } from '@/components/nav-main';
import {
    Sidebar,
    SidebarContent,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from '@/components/ui/sidebar';
import { dashboard, studio } from '@/routes';
import { edit as editAppearance } from '@/routes/appearance';
import foliage from '@/routes/foliage';
import gameSettings from '@/routes/game-settings';
import maps from '@/routes/maps';
import type { NavGroup } from '@/types';

const navGroups: NavGroup[] = [
    {
        title: 'World',
        items: [
            { title: 'Dashboard', href: dashboard(), icon: LayoutGrid },
            {
                title: 'Maps',
                href: maps.index(),
                icon: MapIcon,
                activePrefix: '/maps',
            },
            { title: 'Open Studio', href: studio(), icon: Clapperboard },
        ],
    },
    {
        title: 'Assets',
        items: [
            {
                title: 'Foliage',
                href: foliage.index(),
                icon: Trees,
                activePrefix: '/foliage',
            },
        ],
    },
    {
        title: 'Configuration',
        items: [
            {
                title: 'Game settings',
                href: gameSettings.edit('player'),
                icon: SlidersHorizontal,
                activePrefix: '/settings/game',
            },
            { title: 'Appearance', href: editAppearance(), icon: Palette },
        ],
    },
];

export function AppSidebar() {
    return (
        <Sidebar collapsible="icon" variant="inset">
            <SidebarHeader>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton size="lg" asChild>
                            <Link href={dashboard()} prefetch>
                                <AppLogo />
                            </Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>

            <SidebarContent className="gap-4 pt-2">
                {navGroups.map((group) => (
                    <NavMain
                        key={group.title}
                        label={group.title}
                        items={group.items}
                    />
                ))}
            </SidebarContent>
        </Sidebar>
    );
}
