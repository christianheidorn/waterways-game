<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Strength of the large-scale colour / brightness variation that hides texture tiling from afar.
        Schema::table('terrain_layers', function (Blueprint $table) {
            $table->double('macro_variation')->default(1);
        });
    }

    public function down(): void
    {
        Schema::table('terrain_layers', function (Blueprint $table) {
            $table->dropColumn('macro_variation');
        });
    }
};
