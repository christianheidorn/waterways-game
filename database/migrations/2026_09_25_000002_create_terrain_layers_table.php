<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('terrain_layers', function (Blueprint $table) {
            $table->id();
            $table->foreignId('map_id')->constrained()->cascadeOnDelete();
            $table->unsignedTinyInteger('slot');
            $table->string('name');
            $table->string('color', 9);
            $table->string('color_secondary', 9);
            $table->double('roughness')->default(0.9);
            $table->double('noise_scale')->default(8);
            $table->double('variation')->default(0.5);
            $table->double('bump')->default(0.5);
            $table->string('texture_path')->nullable();
            $table->double('texture_scale')->default(4);
            $table->double('auto_min_height')->nullable();
            $table->double('auto_max_height')->nullable();
            $table->double('auto_min_slope')->nullable();
            $table->double('auto_max_slope')->nullable();
            $table->integer('auto_priority')->default(0);
            $table->timestamps();

            $table->unique(['map_id', 'slot']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('terrain_layers');
    }
};
