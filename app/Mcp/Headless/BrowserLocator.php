<?php

namespace App\Mcp\Headless;

use App\Mcp\ToolError;
use Symfony\Component\Process\ExecutableFinder;

/**
 * Finds a Chromium-family browser for hidden editors: WATERWAYS_BROWSER_PATH when set, else the first
 * installed of Chrome, Chromium, Edge and Brave (macOS apps, then the PATH, then Playwright's Chromium).
 */
class BrowserLocator
{
    /** Absolute paths, or program names looked up on the PATH, in order of preference. */
    public const CANDIDATES = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        'google-chrome',
        'google-chrome-stable',
        'chromium',
        'chromium-browser',
        'microsoft-edge',
        'brave-browser',
        '/opt/pw-browsers/chromium',
    ];

    /**
     * @param  list<string>  $candidates
     */
    public function __construct(
        private readonly ?string $configured = null,
        private readonly array $candidates = self::CANDIDATES,
    ) {}

    /**
     * The browser binary to run.
     *
     * @throws ToolError when none is found or the configured one does not exist
     */
    public function find(): string
    {
        if ($this->configured !== null && $this->configured !== '') {
            return is_file($this->configured) && is_executable($this->configured)
                ? $this->configured
                : throw new ToolError("WATERWAYS_BROWSER_PATH is \"{$this->configured}\", which is not an executable file. Point it at a Chrome, Chromium, Edge or Brave binary.");
        }

        $finder = new ExecutableFinder;

        foreach ($this->candidates as $candidate) {
            $path = str_contains($candidate, '/') ? $candidate : $finder->find($candidate);

            if ($path !== null && is_file($path) && is_executable($path)) {
                return $path;
            }
        }

        throw new ToolError('No Chrome-family browser found for a hidden editor. Install Google Chrome (or Chromium, Edge, Brave), or set WATERWAYS_BROWSER_PATH in .env to its binary. Or ask the user to open the map in the studio.');
    }
}
