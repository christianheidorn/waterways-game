<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Floating on water: {mode: float, density: share of the height under water, drift: none | return | stay}; null sinks / stands.
        Schema::table('prop_models', function (Blueprint $table) {
            $table->json('buoyancy')->nullable()->after('collision');
        });
    }

    public function down(): void
    {
        Schema::table('prop_models', function (Blueprint $table) {
            $table->dropColumn('buoyancy');
        });
    }
};
