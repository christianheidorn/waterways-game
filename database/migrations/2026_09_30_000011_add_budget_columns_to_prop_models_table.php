<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Rendering cost of one instance, measured from the GLB (null: not measured yet).
        Schema::table('prop_models', function (Blueprint $table) {
            $table->unsignedInteger('triangles')->nullable()->after('dimensions');
            // Mesh primitives: each is one draw call per instance and pass.
            $table->unsignedInteger('meshes')->nullable()->after('triangles');
            $table->unsignedInteger('materials')->nullable()->after('meshes');
        });
    }

    public function down(): void
    {
        Schema::table('prop_models', function (Blueprint $table) {
            $table->dropColumn(['triangles', 'meshes', 'materials']);
        });
    }
};
