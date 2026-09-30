<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Library of placeable 3D models (props: huts, bridges, rocks, …) shared by all maps.
        Schema::create('prop_models', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            // building | structure | nature | decoration | other
            $table->string('category')->default('other');
            // upload | blender | url | meshy | ai
            $table->string('source')->default('upload');
            // processing | ready | failed
            $table->string('status')->default('ready');
            $table->text('status_message')->nullable();
            // GLB on the public disk, e.g. props/12/model.glb.
            $table->string('model_path')->nullable();
            $table->string('thumbnail_path')->nullable();
            // Wanted real-world height (m): the game scales the model to it (null = the model's own size).
            $table->double('target_height')->nullable();
            // Measured size of the model at scale 1 (m), when known.
            $table->json('dimensions')->nullable();
            $table->json('tags')->nullable();
            $table->text('prompt')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('prop_models');
    }
};
