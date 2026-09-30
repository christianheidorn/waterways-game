<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Hidden editors the MCP server started (one browser process per map, see App\Mcp\HeadlessEditor).
        Schema::create('headless_browsers', function (Blueprint $table) {
            $table->id();
            $table->foreignId('map_id')->unique()->constrained()->cascadeOnDelete();
            $table->unsignedInteger('pid');
            $table->string('browser');
            $table->text('url');
            // The browser's own profile directory: also identifies the process (pids are reused).
            $table->string('profile_dir');
            $table->timestamp('started_at');
            // Last command an agent ran in it (idle shutdown).
            $table->timestamp('last_used_at');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('headless_browsers');
    }
};
