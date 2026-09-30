<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Guards the HTTP MCP endpoint: requests need `Authorization: Bearer <WATERWAYS_MCP_TOKEN>`.
 */
class RequireMcpToken
{
    public function handle(Request $request, Closure $next): Response
    {
        $token = (string) config('services.mcp.token');

        if ($token === '' || ! hash_equals($token, (string) $request->bearerToken())) {
            return response()->json(['error' => 'Unauthorized'], 401);
        }

        return $next($request);
    }
}
