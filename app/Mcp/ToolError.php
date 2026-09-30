<?php

namespace App\Mcp;

use RuntimeException;

/**
 * An expected failure of an agent tool (no editor open, unknown map, …): its message is shown to the
 * agent as the tool result, so it should say what to do next.
 */
class ToolError extends RuntimeException {}
