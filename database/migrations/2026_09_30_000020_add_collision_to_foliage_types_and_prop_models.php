<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // auto (trees: trunk, rocks: bounds, others: none), none, trunk, bounds; radius overrides the measured one.
        Schema::table('foliage_types', function (Blueprint $table) {
            $table->string('collision', 16)->default('auto')->after('allow_underwater');
            $table->float('collision_radius')->nullable()->after('collision');
        });

        // auto (boxes fitted to the model), box, mesh (exact triangles), none.
        Schema::table('prop_models', function (Blueprint $table) {
            $table->string('collision', 16)->default('auto')->after('target_height');
        });
    }

    public function down(): void
    {
        Schema::table('foliage_types', function (Blueprint $table) {
            $table->dropColumn(['collision', 'collision_radius']);
        });

        Schema::table('prop_models', function (Blueprint $table) {
            $table->dropColumn('collision');
        });
    }
};
