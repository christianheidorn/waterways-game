<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('maps', function (Blueprint $table) {
            $table->double('lake_depth')->default(6)->after('import_water');
            $table->double('river_depth')->default(2)->after('lake_depth');
            $table->double('shore_angle')->default(15)->after('river_depth');
            $table->double('bank_angle')->default(35)->after('shore_angle');
            $table->double('smoothing')->default(0.5)->after('bank_angle');
        });
    }

    public function down(): void
    {
        Schema::table('maps', function (Blueprint $table) {
            $table->dropColumn(['lake_depth', 'river_depth', 'shore_angle', 'bank_angle', 'smoothing']);
        });
    }
};
