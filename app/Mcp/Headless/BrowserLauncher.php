<?php

namespace App\Mcp\Headless;

use Illuminate\Container\Attributes\Bind;

/**
 * Starts and stops the browser processes of hidden editors (see App\Mcp\HeadlessEditor). An
 * interface so tests can fake the processes.
 */
#[Bind(ProcessBrowserLauncher::class)]
interface BrowserLauncher
{
    /**
     * Starts the browser detached from the calling process (it keeps running when the MCP server
     * exits) and returns its process id.
     *
     * @param  list<string>  $arguments
     */
    public function launch(string $binary, array $arguments, string $logFile): int;

    /**
     * Whether the process is still running. `$marker` is a string from its command line (the
     * browser's profile directory), so a reused process id of another program is not mistaken for it.
     */
    public function running(int $pid, string $marker): bool;

    /** Stops the process (and with it the browser's helper processes). */
    public function stop(int $pid, string $marker): void;
}
