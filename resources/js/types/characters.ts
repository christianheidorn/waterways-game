import type { CharacterRef } from '@game/shared/types';

/** Mirrors App\Models\Character::toStudioArray(). */
export type CharacterStudio = CharacterRef & {
    source: 'meshy' | 'upload';
    prompt: string | null;
    style: number;
    thumbnail_url: string | null;
    clips: string[];
    meta: { meshy_credits?: number; pipeline?: { stage?: string } };
    status: 'queued' | 'processing' | 'ready' | 'failed';
    status_message: string | null;
    ai_model: string | null;
    active: boolean;
    created_at: string | null;
};
