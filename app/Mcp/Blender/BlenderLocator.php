<?php

namespace App\Mcp\Blender;

use Illuminate\Support\Facades\Process;
use Throwable;

/**
 * Finds the Blender executable for headless jobs: WATERWAYS_BLENDER_PATH (services.blender.path), the
 * macOS app (Homebrew cask or download), `blender` on PATH, then common Linux locations.
 */
class BlenderLocator
{
    /** @var list<string> */
    public const COMMON_PATHS = [
        '/Applications/Blender.app/Contents/MacOS/Blender',
        '~/Applications/Blender.app/Contents/MacOS/Blender',
        '/opt/homebrew/bin/blender',
        '/usr/local/bin/blender',
        '/usr/bin/blender',
        '/snap/bin/blender',
        '/var/lib/flatpak/exports/bin/org.blender.Blender',
        '/opt/blender/blender',
    ];

    /** @var array<string, string|null> */
    private array $versions = [];

    /**
     * @param  list<string>|null  $searchPaths  replaces PATH + COMMON_PATHS (tests)
     */
    public function __construct(private ?array $searchPaths = null) {}

    /** The configured path (WATERWAYS_BLENDER_PATH), if any. */
    public function configured(): ?string
    {
        $path = config('services.blender.path');

        return is_string($path) && trim($path) !== '' ? self::expand(trim($path)) : null;
    }

    /** Absolute path of the Blender executable, or null when none is installed / configured. */
    public function find(): ?string
    {
        $configured = $this->configured();
        if ($configured !== null) {
            return self::executable($configured) ? $configured : null;
        }

        foreach ($this->candidates() as $path) {
            if (self::executable($path)) {
                return $path;
            }
        }

        return null;
    }

    /** @return list<string> the places searched, in order */
    public function candidates(): array
    {
        if ($this->searchPaths !== null) {
            return array_map(self::expand(...), $this->searchPaths);
        }

        $onPath = array_map(
            fn (string $dir) => rtrim($dir, '/').'/blender',
            array_filter(explode(PATH_SEPARATOR, (string) getenv('PATH'))),
        );

        return array_values(array_unique([
            self::expand(self::COMMON_PATHS[0]),
            self::expand(self::COMMON_PATHS[1]),
            ...$onPath,
            ...array_map(self::expand(...), array_slice(self::COMMON_PATHS, 2)),
        ]));
    }

    /** "4.2.3 LTS" etc. from `blender --version`, or null. */
    public function version(string $path): ?string
    {
        if (array_key_exists($path, $this->versions)) {
            return $this->versions[$path];
        }

        try {
            $result = Process::timeout(60)->run([$path, '--background', '--factory-startup', '--version']);
            $version = preg_match('/Blender\s+(\d+\.\d+(?:\.\d+)?(?:\s+LTS)?)/', $result->output(), $m) ? $m[1] : null;
        } catch (Throwable) {
            $version = null;
        }

        return $this->versions[$path] = $version;
    }

    /**
     * @return array{found: bool, path: string|null, version: string|null, configured: string|null, searched: list<string>}
     */
    public function status(): array
    {
        $path = $this->find();

        return [
            'found' => $path !== null,
            'path' => $path,
            'version' => $path !== null ? $this->version($path) : null,
            'configured' => $this->configured(),
            'searched' => $this->configured() !== null ? [$this->configured()] : $this->candidates(),
        ];
    }

    /** What to tell the user when Blender is missing. */
    public function installHelp(): string
    {
        $configured = $this->configured();
        $lead = $configured !== null
            ? "WATERWAYS_BLENDER_PATH is set to \"{$configured}\", but no executable is there."
            : 'Blender is not installed (or not found).';

        return $lead.' Ask the user to install Blender 4.2 LTS or newer: on macOS `brew install --cask blender` '
            .'(or download it from blender.org into /Applications), on Linux the official tarball from blender.org, '
            .'the distribution package or `snap install blender --classic`. If it lives somewhere else, set '
            .'WATERWAYS_BLENDER_PATH in .env to the executable (macOS: /Applications/Blender.app/Contents/MacOS/Blender) '
            .'and restart the MCP server. blender_status checks it.';
    }

    private static function executable(string $path): bool
    {
        return is_file($path) && is_executable($path);
    }

    private static function expand(string $path): string
    {
        if (str_starts_with($path, '~/')) {
            $home = getenv('HOME') ?: ($_SERVER['HOME'] ?? '');

            return rtrim((string) $home, '/').substr($path, 1);
        }

        return $path;
    }
}
