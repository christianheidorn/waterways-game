<?php

use App\Http\Middleware\RequireMcpToken;
use App\Mcp\Servers\WaterwaysServer;
use Laravel\Mcp\Facades\Mcp;

// Local MCP server for AI agents (Claude Desktop / Claude Code): `php artisan mcp:start waterways`.
Mcp::local('waterways', WaterwaysServer::class);

// Optional HTTP endpoint (for clients that cannot start a local process): only with a token set.
if (config('services.mcp.token')) {
    Mcp::web('/mcp', WaterwaysServer::class)->middleware(RequireMcpToken::class);
}
