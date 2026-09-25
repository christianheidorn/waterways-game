<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('foliage_types', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('kind');
            $table->string('color', 9);
            $table->string('color_secondary', 9);
            $table->string('model_path')->nullable();
            $table->double('min_scale')->default(0.8);
            $table->double('max_scale')->default(1.2);
            $table->double('density')->default(1);
            $table->double('min_slope')->default(0);
            $table->double('max_slope')->default(35);
            $table->double('min_height')->nullable();
            $table->double('max_height')->nullable();
            $table->boolean('align_to_normal')->default(false);
            $table->boolean('random_yaw')->default(true);
            $table->boolean('cast_shadows')->default(true);
            $table->double('cull_distance')->default(600);
            $table->boolean('allow_underwater')->default(false);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('foliage_types');
    }
};
