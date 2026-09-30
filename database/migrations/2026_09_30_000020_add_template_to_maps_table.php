<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // The map template it was created from (App\Support\MapTemplates key), applied after generation.
        Schema::table('maps', function (Blueprint $table) {
            $table->string('template', 40)->nullable()->after('seed');
        });
    }

    public function down(): void
    {
        Schema::table('maps', function (Blueprint $table) {
            $table->dropColumn('template');
        });
    }
};
