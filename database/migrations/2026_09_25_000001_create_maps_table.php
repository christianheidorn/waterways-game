<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('maps', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('slug')->unique();
            $table->text('description')->nullable();
            $table->string('source')->default('procedural');
            $table->unsignedInteger('resolution')->default(513);
            $table->double('size')->default(2048);
            $table->double('center_lat')->nullable();
            $table->double('center_lng')->nullable();
            $table->double('height_scale')->default(1);
            $table->boolean('import_water')->default(true);
            $table->unsignedInteger('seed')->default(1337);
            $table->double('min_height')->default(0);
            $table->double('max_height')->default(0);
            $table->double('spawn_x')->nullable();
            $table->double('spawn_z')->nullable();
            $table->double('spawn_yaw')->default(0);
            $table->json('environment')->nullable();
            $table->string('terrain_status')->default('queued');
            $table->unsignedTinyInteger('terrain_progress')->default(0);
            $table->string('terrain_message')->nullable();
            $table->unsignedInteger('revision')->default(0);
            $table->boolean('is_default')->default(false);
            $table->timestamp('terrain_generated_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('maps');
    }
};
