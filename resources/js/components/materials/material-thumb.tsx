import { ImageOff } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

type Props = {
    src: string | null | undefined;
    alt: string;
    className?: string;
    /** Shown behind the image and when it is missing or fails to load. */
    fallbackColor?: string;
    iconClassName?: string;
};

/** Square-ish material image with a neutral checker placeholder when missing or broken. */
export function MaterialThumb({
    src,
    alt,
    className,
    fallbackColor,
    iconClassName,
}: Props) {
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const failed = !src || failedSrc === src;

    return (
        <div
            className={cn(
                'relative overflow-hidden bg-muted bg-[repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]',
                className,
            )}
            style={
                failed && fallbackColor
                    ? { backgroundColor: fallbackColor }
                    : undefined
            }
        >
            {!failed ? (
                <img
                    src={src}
                    alt={alt}
                    loading="lazy"
                    decoding="async"
                    onError={() => setFailedSrc(src)}
                    className="absolute inset-0 size-full object-cover"
                />
            ) : (
                <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/60">
                    <ImageOff className={cn('size-5', iconClassName)} />
                    <span className="sr-only">{alt} (no image)</span>
                </div>
            )}
        </div>
    );
}

/** Best image for a library material: thumbnail, then albedo. */
export function materialImage(material: {
    thumbnail_url?: string | null;
    maps: { albedo: string | null };
}): string | null {
    return material.thumbnail_url ?? material.maps.albedo ?? null;
}
