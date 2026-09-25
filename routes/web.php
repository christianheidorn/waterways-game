<?php

use Illuminate\Support\Facades\Route;

Route::redirect('/', '/dashboard')->name('home');
Route::inertia('dashboard', 'dashboard')->name('dashboard');
