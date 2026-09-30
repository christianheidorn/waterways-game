<?php

namespace App\Mcp\Headless;

use RuntimeException;
use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;

/**
 * Runs hidden editor browsers as background processes (macOS and Linux).
 *
 * A Symfony Process stops its child when the PHP object goes away, so the browser is started by a
 * short-lived shell instead: `nohup … &` detaches it (it is re-parented once the shell exits, and
 * survives the MCP server's stdio process), and the shell prints its pid. Where `setsid` exists
 * (Linux), the browser also gets its own session, so signals to the MCP client's process group
 * do not reach it.
 */
class ProcessBrowserLauncher implements BrowserLauncher
{
    public function launch(string $binary, array $arguments, string $logFile): int
    {
        $command = implode(' ', array_map(escapeshellarg(...), [$binary, ...$arguments]));
        $setsid = (new ExecutableFinder)->find('setsid') !== null ? 'setsid ' : '';

        $process = Process::fromShellCommandline(
            "{$setsid}nohup {$command} > ".escapeshellarg($logFile).' 2>&1 < /dev/null & echo $!',
        );
        $process->setTimeout(15)->mustRun();

        $pid = (int) trim($process->getOutput());

        if ($pid <= 0) {
            throw new RuntimeException('The browser did not start: '.trim($process->getErrorOutput()));
        }

        return $pid;
    }

    public function running(int $pid, string $marker): bool
    {
        // `ps` works the same on macOS and Linux; an exited (zombie) process has no arguments left.
        $process = new Process(['ps', '-p', (string) $pid, '-o', 'command=']);
        $process->run();

        return $process->isSuccessful() && str_contains($process->getOutput(), $marker);
    }

    public function stop(int $pid, string $marker): void
    {
        if (! $this->running($pid, $marker)) {
            return;
        }

        $this->signal($pid, 15);

        // Chrome shuts down its helper processes on SIGTERM; give it a moment before forcing it.
        for ($i = 0; $i < 50 && $this->running($pid, $marker); $i++) {
            usleep(100_000);
        }

        if ($this->running($pid, $marker)) {
            $this->signal($pid, 9);
        }
    }

    private function signal(int $pid, int $signal): void
    {
        if (function_exists('posix_kill')) {
            posix_kill($pid, $signal);

            return;
        }

        (new Process(['kill', "-{$signal}", (string) $pid]))->run();
    }
}
