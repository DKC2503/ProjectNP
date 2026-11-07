const mongoose = require('mongoose');
require('dotenv').config({ override: true });
const User = require('../models/User');

const SUPER_ADMIN_EMAIL = 'karthikchaitanya.d@gmail.com';

const demoteExtraSuperAdmins = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("Connected to MongoDB");

        const superAdmins = await User.find({ role: 'super_admin' });
        console.log(`Found ${superAdmins.length} Super Admins`);

        for (const user of superAdmins) {
            if (user.email.toLowerCase() !== SUPER_ADMIN_EMAIL.toLowerCase()) {
                console.log(`Demoting ${user.email} to admin...`);
                user.role = 'admin';
                await user.save();
            }
        }

        console.log("Super Admin cleanup complete.");
        process.exit(0);
    } catch (err) {
        console.error("Cleanup failed:", err);
        process.exit(1);
    }
};

demoteExtraSuperAdmins();
