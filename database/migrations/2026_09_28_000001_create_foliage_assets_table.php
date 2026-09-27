<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('foliage_assets', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('kind');
            // realistic | stylized
            $table->string('style')->default('realistic');
            // polyhaven | upload | ai
            $table->string('source')->default('upload');
            $table->string('source_ref')->nullable();
            $table->string('source_url')->nullable();
            $table->string('author')->nullable();
            $table->string('license')->nullable();
            $table->json('tags')->nullable();
            // model (glTF / GLB) | card (a single plant image built into crossed cards)
            $table->string('source_type')->default('model');
            $table->string('source_path')->nullable();
            $table->json('bake_options')->nullable();
            // Wanted real-world height in metres (null = keep the model's own size).
            $table->double('target_height')->nullable();
            $table->string('model_path')->nullable();
            $table->string('thumbnail_path')->nullable();
            $table->json('meta')->nullable();
            // queued | processing | awaiting_bake | ready | failed
            $table->string('status')->default('queued');
            $table->string('status_message')->nullable();
            $table->text('ai_prompt')->nullable();
            $table->string('ai_model')->nullable();
            $table->timestamps();

            $table->index(['source', 'source_ref']);
        });

        Schema::table('foliage_types', function (Blueprint $table) {
            $table->foreignId('foliage_asset_id')->nullable()->after('model_path')->constrained('foliage_assets')->nullOnDelete();
            $table->string('tint', 9)->default('#ffffff')->after('foliage_asset_id');
        });
    }

    public function down(): void
    {
        Schema::table('foliage_types', function (Blueprint $table) {
            $table->dropConstrainedForeignId('foliage_asset_id');
            $table->dropColumn('tint');
        });

        Schema::dropIfExists('foliage_assets');
    }
};
