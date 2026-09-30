<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Open editors that can run commands for AI agents (the live bridge of the MCP server).
        Schema::create('agent_sessions', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->foreignId('map_id')->constrained()->cascadeOnDelete();
            // edit | play
            $table->string('mode')->default('edit');
            // Camera, view mode, unsaved channels, … as last reported by the editor.
            $table->json('state')->nullable();
            $table->timestamp('last_seen_at');
            $table->timestamps();
        });

        // Commands queued by the MCP server for the open editor of a map, and their results.
        Schema::create('agent_commands', function (Blueprint $table) {
            $table->id();
            $table->foreignId('map_id')->constrained()->cascadeOnDelete();
            $table->string('session_id')->nullable();
            $table->string('type');
            $table->json('payload')->nullable();
            // pending | running | done | failed
            $table->string('status')->default('pending');
            $table->longText('result')->nullable();
            $table->text('error')->nullable();
            $table->timestamp('claimed_at')->nullable();
            $table->timestamp('finished_at')->nullable();
            $table->timestamps();
            $table->index(['map_id', 'status']);
        });

        // Restore points of a map: stored terrain assets plus its layers and settings.
        Schema::create('map_snapshots', function (Blueprint $table) {
            $table->id();
            $table->foreignId('map_id')->constrained()->cascadeOnDelete();
            $table->string('label');
            // Taken automatically before an agent changed the map.
            $table->boolean('auto')->default(false);
            $table->json('data');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('map_snapshots');
        Schema::dropIfExists('agent_commands');
        Schema::dropIfExists('agent_sessions');
    }
};
