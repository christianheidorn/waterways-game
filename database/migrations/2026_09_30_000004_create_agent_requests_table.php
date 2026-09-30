<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Build requests for AI agents, made in the editor: an outlined area, a note and images.
        Schema::create('agent_requests', function (Blueprint $table) {
            $table->id();
            $table->foreignId('map_id')->constrained()->cascadeOnDelete();
            // open | in_progress | needs_input | done | dismissed
            $table->string('status')->default('open');
            $table->text('note');
            // Outline in world metres: [{x, z}, …] (a polygon).
            $table->json('area');
            // Editor camera when the request was made: {position: {x, y, z}, direction: {x, y, z}}.
            $table->json('camera')->nullable();
            // Images on the public disk (agent-requests/{id}/…).
            $table->string('screenshot_path')->nullable();
            $table->json('reference_paths')->nullable();
            $table->json('result_paths')->nullable();
            // The agent's latest reply (what it did, or a question).
            $table->text('agent_message')->nullable();
            $table->timestamps();
            $table->index(['map_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('agent_requests');
    }
};
