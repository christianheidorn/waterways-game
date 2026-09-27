<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('characters', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            // meshy | upload
            $table->string('source')->default('meshy');
            $table->text('prompt')->nullable();
            $table->unsignedTinyInteger('style')->default(20);
            $table->double('height')->default(1.8);
            $table->string('model_path')->nullable();
            // clip (idle / walk / run / jump / swim) → storage path of an animation GLB
            $table->json('animations')->nullable();
            $table->string('thumbnail_path')->nullable();
            $table->json('meta')->nullable();
            // queued | processing | ready | failed
            $table->string('status')->default('queued');
            $table->string('status_message')->nullable();
            $table->string('ai_model')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('characters');
    }
};
