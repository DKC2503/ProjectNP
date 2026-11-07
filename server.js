// --- GLOBAL EXCEPTION & REJECTION HANDLERS ---
process.on("uncaughtException", (err) => {
    console.error("🔥 CRITICAL: Uncaught Exception detected:", err.message);
    console.error(err.stack);
    try {
        const { logError } = require('./middleware/logger');
        logError(err, null, "UNCAUGHT EXCEPTION");
    } catch (e) {
        console.error("Failed to log uncaught exception to file:", e.message);
    }
    process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("🔥 CRITICAL: Unhandled Promise Rejection detected at:", promise, "reason:", reason);
    try {
        const { logError } = require('./middleware/logger');
        const err = reason instanceof Error ? reason : new Error(String(reason));
        logError(err, null, "UNHANDLED REJECTION");
    } catch (e) {
        console.error("Failed to log unhandled rejection to file:", e.message);
    }
});

const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
require('dotenv').config({ override: true });
const mongoose = require('mongoose'); // Added mongoose import for connection tracking
const UAParser = require('ua-parser-js');
const { connectDB, getHealthStatus } = require('./config/database');

// ... (previous imports)

// --- HELPERS ---
const getDeviceInfo = (userAgentString) => {
    const parser = new UAParser(userAgentString);
    const result = parser.getResult();
    return {
        browser: `${result.browser.name || 'Unknown'} ${result.browser.version || ''}`.trim(),
        operatingSystem: `${result.os.name || 'Unknown'} ${result.os.version || ''}`.trim(),
        deviceType: result.device.type || 'desktop'
    };
};

const ensureUniqueSlug = async (slug, articleId = null) => {
    let uniqueSlug = slug;
    let counter = 1;
    while (true) {
        const query = { slug: uniqueSlug };
        if (articleId) {
            query._id = { $ne: articleId };
        }
        const existing = await Article.findOne(query);
        if (!existing) {
            break;
        }
        uniqueSlug = `${slug}-${counter}`;
        counter++;
    }
    return uniqueSlug;
};

const applySeoDefaults = async (articleData, articleId = null) => {
    let { title, content, seoTitle, metaDescription, slug, keywords, canonicalUrl, robotsDirective, openGraphImage } = articleData;
    
    // Default values if empty
    if (!seoTitle || seoTitle.trim() === '') {
        seoTitle = title || '';
    }
    
    if (!metaDescription || metaDescription.trim() === '') {
        let cleanText = (content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleanText.length > 157) {
            cleanText = cleanText.substring(0, 157) + '...';
        }
        metaDescription = cleanText || title || '';
    }
    
    let baseSlug = slug;
    if (!baseSlug || baseSlug.trim() === '') {
        baseSlug = title || '';
    }
    baseSlug = baseSlug
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
    if (!baseSlug || baseSlug === '-') {
        baseSlug = 'article-' + Math.floor(Math.random() * 10000);
    }
    
    slug = await ensureUniqueSlug(baseSlug, articleId);
    
    if (!keywords || keywords.length === 0) {
        const words = (title || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 3 && !['with', 'this', 'that', 'from', 'your', 'about', 'their', 'there', 'news', 'percent'].includes(w));
        keywords = [...new Set(words)].slice(0, 5);
    }
    
    if (!canonicalUrl || canonicalUrl.trim() === '') {
        const appUrl = process.env.APP_URL || '';
        canonicalUrl = appUrl ? `${appUrl}/article/${slug}` : `/article/${slug}`;
    }
    
    if (!robotsDirective || robotsDirective.trim() === '') {
        robotsDirective = 'index, follow';
    }
    
    if (!openGraphImage || openGraphImage.trim() === '') {
        openGraphImage = articleData.featuredImage || '';
    }
    
    // Automatically generate schema markup
    const appUrl = process.env.APP_URL || '';
    const schemaMarkup = {
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        "headline": title || '',
        "image": [articleData.featuredImage || ''],
        "datePublished": articleData.publishedAt || new Date().toISOString(),
        "dateModified": new Date().toISOString(),
        "author": [{
            "@type": "Person",
            "name": articleData.authorName || 'NewsPercent Author',
            "url": appUrl ? `${appUrl}/author/${articleData.authorId || ''}` : `/author/${articleData.authorId || ''}`
        }],
        "publisher": {
            "@type": "Organization",
            "name": "NewsPercent",
            "logo": {
                "@type": "ImageObject",
                "url": appUrl ? `${appUrl}/logo.webp` : '/logo.webp'
            }
        },
        "description": metaDescription || '',
        "mainEntityOfPage": {
            "@type": "WebPage",
            "@id": appUrl ? `${appUrl}/article/${slug}` : `/article/${slug}`
        },
        "articleSection": articleData.category || 'News',
        "keywords": keywords.join(', ')
    };

    return { 
        seoTitle, 
        metaDescription, 
        slug, 
        keywords, 
        canonicalUrl, 
        robotsDirective, 
        openGraphImage,
        schemaMarkup
    };
};

// Import Models
const User = require('./models/User');
const Article = require('./models/Article');
const FlashNews = require('./models/FlashNews');
const LoginLog = require('./models/LoginLog');
const OTP = require('./models/OTP');
const CreditRule = require('./models/CreditRule');
const CreditTransaction = require('./models/CreditTransaction');
const ActivityLog = require('./models/ActivityLog');
const Analytics = require('./models/Analytics');
const Notification = require('./models/Notification');
const StorageConfig = require('./models/StorageConfig');
const StorageHistory = require('./models/StorageHistory');
const { encrypt, decrypt } = require('./utils/crypto');

// Import Services & Middleware
const creditService = require('./services/creditService');
const exportService = require('./services/exportService');
const emailService = require('./services/emailService');
const settingsService = require('./services/settingsService');
const analyticsRoutes = require('./routes/analyticsRoutes');
const marketService = require('./services/marketService');
const weatherService = require('./services/weatherService');
const populationService = require('./services/populationService');
const uploadProfileImage = require('./services/uploadProfileImage');
const uploadArticleImage = require('./services/uploadArticleImage');

const authUtils = require('./utils/auth');
const { verifyToken, requireAdmin, requireSuperAdmin, requireEditor, requireReviewer } = require('./middleware/auth');

// Helper for generating Admin Notifications
const createAdminNotification = async (title, message) => {
    try {
        const User = require('./models/User');
        const Notification = require('./models/Notification');
        const admins = await User.find({ role: { $in: ['super_admin', 'admin', 'editor', 'reviewer'] } });
        const notifications = admins.map(admin => ({
            userId: admin._id.toString(),
            title,
            message,
            isRead: false,
            createdAt: new Date()
        }));
        if (notifications.length > 0) {
            await Notification.insertMany(notifications);
            console.log(`[SYS_NOTIF] Created ${notifications.length} admin notifications: "${title}"`);
        }
    } catch (err) {
        console.error('Error creating admin notification:', err);
    }
};

// Configure Cloudinary Accounts
require('./config/cloudinaryProfile');
require('./config/cloudinaryArticle');

const app = express();
const PORT = process.env.PORT || 3000;

// Import Production Logging Middleware
const { logger, logError } = require('./middleware/logger');

// --- MIDDLEWARE (Tier 1: SECURITY & PARSING) ---
// Configure CORS allowed origins dynamically based on environment
let allowedOrigins = [];
if (process.env.ALLOWED_ORIGINS) {
  allowedOrigins = process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
}
if (process.env.APP_URL && !allowedOrigins.includes(process.env.APP_URL)) {
  allowedOrigins.push(process.env.APP_URL);
}

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    if (allowedOrigins.length === 0) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true
}));

app.use(logger);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const handleError = (res, error, context = 'Server Error') => {
    // Safely log the error to console/file
    logError(error, null, context);
    
    const isMongoError = error.name === 'MongoError' || 
                         error.name === 'ValidationError' || 
                         error.name === 'MongooseError' ||
                         error.message.toLowerCase().includes('mongo') || 
                         error.message.toLowerCase().includes('mongoose') ||
                         error.message.toLowerCase().includes('connection') ||
                         error.message.toLowerCase().includes('topology');
                         
    const errResponse = {
        success: false,
        error: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : (error.message || 'Internal Server Error'),
        context,
        databaseState: mongoose.connection.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED',
        isMongoError,
        timestamp: new Date().toISOString()
    };

    if (process.env.NODE_ENV !== 'production') {
        errResponse.stack = error.stack;
    }
                         
    return res.status(500).json(errResponse);
};

// --- MARKET INTEL API ---
app.get('/api/market/intel', async (req, res) => {
    try {
        const intel = await marketService.getMarketData();
        res.status(200).json(intel);
    } catch (err) {
        handleError(res, err, 'Market Intel Error');
    }
});

// --- WEATHER API ---
app.get('/api/weather/report', async (req, res) => {
    try {
        const { q, lat, lon } = req.query;
        let query = q;
        if (!query && lat && lon) {
            query = `${lat},${lon}`;
        }
        
        if (!query) {
            const userIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;
            const cleanIp = userIp ? userIp.replace('::ffff:', '') : '::1';
            
            const economyService = require('./services/economyService');
            const geo = await economyService.getGeoLocation(cleanIp);
            if (geo && geo.city) {
                query = geo.city;
            }
        }
        
        if (!query) {
            query = 'New Delhi';
        }
        
        const result = await weatherService.getWeatherData(query);
        res.status(200).json(result);
    } catch (err) {
        handleError(res, err, 'Weather API Error');
    }
});

// --- POPULATION INTELLIGENCE API ---
app.get('/api/population/intel', async (req, res) => {
    try {
        const intel = await populationService.getPopulationIntel();
        res.status(200).json(intel);
    } catch (err) {
        handleError(res, err, 'Population Intel Error');
    }
});

// --- ECONOMY INTELLIGENCE API ---
const economyService = require('./services/economyService');

app.get('/api/economy/intel', async (req, res) => {
    try {
        const userIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;
        const cleanIp = userIp ? userIp.replace('::ffff:', '') : '::1';
        const intel = await economyService.getEconomyIntel(cleanIp);
        res.status(200).json(intel);
    } catch (err) {
        handleError(res, err, 'Economy Intel Error');
    }
});

app.get('/api/economy/compare', async (req, res) => {
    try {
        const { state, city } = req.query;
        const userIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;
        const cleanIp = userIp ? userIp.replace('::ffff:', '') : '::1';
        const result = await economyService.getRegionalComparison(state || '', city || '', cleanIp);
        res.status(200).json(result);
    } catch (err) {
        handleError(res, err, 'Economy Regional Compare Error');
    }
});

// --- ANALYTICS ROUTES ---
app.use('/api/analytics', analyticsRoutes);

// --- REQUEST LOGGING ---
app.use((req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.originalUrl}`);
    next();
});

// --- SYSTEM DIAGNOSTICS ---
app.get('/api/health', (req, res) => {
    try {
        const dbStatus = getHealthStatus();
        res.json({
            status: "ok",
            ...dbStatus,
            uptime: process.uptime(),
            timestamp: new Date()
        });
    } catch (err) {
        handleError(res, err, 'Health Check Error');
    }
});

// --- SUPER ADMIN INITIALIZATION ---
const SUPER_ADMIN_EMAIL = 'karthikchaitanya.d@gmail.com';
const initializeSuperAdmin = async () => {
    try {
        const superAdminExists = await User.findOne({ email: SUPER_ADMIN_EMAIL });
        
        if (superAdminExists) {
            console.log("Current User:", superAdminExists);
            console.log("Profile Image:", superAdminExists.profileImage);
        } else {
            const superAdmin = {
                name: "Karthik",
                email: SUPER_ADMIN_EMAIL,
                role: "super_admin",
                isActive: true,
                createdAt: new Date()
            };
            const createdAdmin = await User.create(superAdmin);
            console.log(`[SYS] Super Admin initialized: ${SUPER_ADMIN_EMAIL}`);
            console.log("Current User:", createdAdmin);
            console.log("Profile Image:", createdAdmin.profileImage);
        }
    } catch (err) {
        console.error('[SYS] Super Admin initialization error:', err);
    }
};
// Initialization will be handled in the startup sequence

// --- AUTHENTICATION API ---

// 1. Send OTP
app.post('/api/auth/send-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            console.log("[OTP] Error: Email missing in request payload");
            return res.status(400).json({ error: 'Email is required.' });
        }

        const normalizedEmail = email.toLowerCase().trim();
        console.log(`[OTP] Initiating access protocol for: ${normalizedEmail}`);

        const user = await User.findOne({ email: normalizedEmail });
        if (!user) {
            console.log(`[OTP] Denied: ${normalizedEmail} (Identity not found in mainframe)`);
            return res.status(403).json({ success: false, message: 'User not authorized.', error: 'User not authorized.' });
        }

        console.log(`[OTP] Node Identified: ${user.email} (Clearance: ${user.role})`);

        if (!user.isActive) {
            console.log(`[OTP] Locked: ${user.email} (Node disabled by command)`);
            return res.status(403).json({ error: 'Permission Denied: Account disabled.' });
        }

        const generatedOTP = authUtils.generateOTP();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        await OTP.deleteMany({ email: normalizedEmail });
        await OTP.create({
            email: normalizedEmail,
            otp: generatedOTP,
            expiresAt
        });

        console.log(`[OTP] Internal code synchronized for ${user.email}`);

        // Send Email with robust error handling
        try {
            console.log(`[OTP] Attempting SMTP transmission to ${user.email}...`);
            await emailService.sendOTP(user.email, generatedOTP);
            console.log(`[OTP] SUCCESS: Transmission verified for ${user.email}`);
            res.json({ 
                success: true, 
                message: 'OTP sent successfully.', 
                profileImage: user.profileImage, 
                name: user.name 
            });
        } catch (emailErr) {
            console.error(`[OTP] SMTP ERROR for ${user.email}:`, emailErr);
            return res.status(500).json({ error: 'Failed to transmit access code. Security server unreachable.' });
        }
    } catch (err) {
        handleError(res, err, 'OTP Send Error');
    }
});

// 2. Verify OTP
app.post('/api/auth/verify-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required.' });

        const otpRecord = await OTP.findOne({ email: email.toLowerCase() });
        const deviceInfo = getDeviceInfo(req.get('User-Agent'));
        
        if (!otpRecord) {
            return res.status(400).json({ error: 'OTP expired or not found.' });
        }
        
        const isMatch = await otpRecord.compareOTP(otp);
        if (!isMatch) {
            const user = await User.findOne({ email: email.toLowerCase() });
            await LoginLog.create({
                userId: user ? user._id : null,
                name: user ? user.name : 'Unknown',
                email: email.toLowerCase(),
                role: user ? user.role : 'unauthorized',
                loginTime: new Date(),
                ipAddress: req.ip,
                ...deviceInfo,
                status: 'failed',
                userAgent: req.get('User-Agent')
            });
            return res.status(400).json({ error: 'Invalid OTP code.' });
        }

        const user = await User.findOne({ email: email.toLowerCase() });
        console.log("Current User:", user);
        console.log("Profile Image:", user ? user.profileImage : undefined);
        
        user.lastLogin = new Date();
        await user.save();

        const token = authUtils.generateToken(user);

        const log = await LoginLog.create({
            userId: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            loginTime: new Date(),
            ipAddress: req.ip,
            ...deviceInfo,
            status: 'success',
            userAgent: req.get('User-Agent')
        });

        await OTP.deleteMany({ email: email.toLowerCase() });

        res.json({
            success: true,
            token,
            loginLogId: log._id,
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                isActive: user.isActive,
                profileImage: user.profileImage
            }
        });
    } catch (err) {
        handleError(res, err, 'OTP Verify Error');
    }
});

// 3. Logout
app.post('/api/auth/logout', verifyToken, async (req, res) => {
    try {
        const { loginLogId } = req.body;
        if (loginLogId) {
            const log = await LoginLog.findById(loginLogId);
            if (log) {
                log.logoutTime = new Date();
                const durationMs = log.logoutTime - log.loginTime;
                log.sessionDuration = Math.round(durationMs / 60000); // duration in minutes
                await log.save();
            }
        }
        res.json({ success: true, message: 'Logged out successfully.' });
    } catch (err) {
        handleError(res, err, 'Logout Error');
    }
});

// 4. Get Current User
app.get('/api/auth/me', verifyToken, (req, res) => {
    try {
        console.log("Current User:", req.user);
        console.log("Profile Image:", req.user ? req.user.profileImage : undefined);
        res.json({ user: req.user });
    } catch (err) {
        handleError(res, err, 'Auth Me Error');
    }
});

// Update Display Name (Unified Admin/Author profile change)
app.put('/api/users/profile/name', verifyToken, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || name.trim() === '') {
            return res.status(400).json({ error: 'Display name cannot be empty' });
        }

        const userId = req.user._id;
        const dbUser = await User.findById(userId);
        if (!dbUser) {
            return res.status(404).json({ error: 'User account not found' });
        }

        const oldName = dbUser.name;
        const newName = name.trim();

        // 1. Update name on user document
        dbUser.name = newName;
        await dbUser.save();

        // 2. Update authorName across all matching articles
        const Article = require('./models/Article');
        await Article.updateMany({ authorId: userId.toString() }, { authorName: newName });

        // 3. Update reviewedBy across all matching articles
        await Article.updateMany({ reviewedBy: oldName }, { reviewedBy: newName });

        // 4. Update userName across activity logs
        const ActivityLog = require('./models/ActivityLog');
        await ActivityLog.updateMany({ userId }, { userName: newName });

        // 5. Update adminName / updatedBy in storage history & configs
        const StorageHistory = require('./models/StorageHistory');
        await StorageHistory.updateMany({ adminName: oldName }, { adminName: newName });
        await StorageConfig.updateMany({ updatedBy: oldName }, { updatedBy: newName });

        console.log(`[USER PROFILE UPDATE] User ${userId} name updated from "${oldName}" to "${newName}"`);
        
        // Return updated user object
        res.json({ 
            success: true, 
            message: 'Display name updated successfully',
            user: {
                _id: dbUser._id,
                name: dbUser.name,
                email: dbUser.email,
                role: dbUser.role,
                isActive: dbUser.isActive,
                profileImage: dbUser.profileImage,
                createdAt: dbUser.createdAt
            }
        });
    } catch (err) {
        handleError(res, err, 'Update Profile Name Error');
    }
});

// --- USER MANAGEMENT API (RBAC PROTECTED) ---

app.get('/api/admin/users', verifyToken, requireAdmin, async (req, res) => {
    try {
        const users = await User.aggregate([
            {
                $addFields: {
                    userIdString: { $toString: "$_id" }
                }
            },
            {
                $lookup: {
                    from: 'articles',
                    localField: 'userIdString',
                    foreignField: 'authorId',
                    as: 'userArticles'
                }
            },
            {
                $addFields: {
                    publishedArticles: {
                        $filter: {
                            input: "$userArticles",
                            as: "art",
                            cond: { $eq: ["$$art.status", "PUBLISHED"] }
                        }
                    }
                }
            },
            {
                $project: {
                    name: 1,
                    email: 1,
                    role: 1,
                    profileImage: 1,
                    isActive: 1,
                    totalCredits: 1,
                    monthlyCredits: 1,
                    yearlyCredits: 1,
                    createdAt: 1,
                    lastLogin: 1,
                    articlesPublished: { $size: "$publishedArticles" },
                    totalViews: { $sum: "$publishedArticles.views" }
                }
            },
            { $sort: { createdAt: -1 } }
        ]);
        res.json(users);
    } catch (err) {
        handleError(res, err, 'Fetch Users Error');
    }
});

app.post('/api/admin/users', verifyToken, requireAdmin, async (req, res) => {
    try {
        console.log('[CREATE USER] Payload:', req.body);
        console.log("[STEP] Validation Started");
        let { name, email, role, profileImage } = req.body;

        if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
        if (!email) return res.status(400).json({ success: false, error: 'Email is required' });
        if (!role) return res.status(400).json({ success: false, error: 'Role is required' });

        email = email.toLowerCase().trim();
        role = role.toLowerCase().trim();

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ success: false, error: 'Invalid email format' });
        }
        
        console.log("[STEP] Email Validation Passed");

        const validRoles = ['super_admin', 'admin', 'editor', 'reviewer', 'author'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({ success: false, error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
        }

        // Only super_admin and admin can create users
        if (!['super_admin', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Permission Denied: Insufficient clearance to create users.' });
        }

        console.log("[STEP] Checking Existing User");
        const exists = await User.findOne({ email });
        if (exists) {
            console.log("[STEP] Existing User Found");
            console.log("[DB] Existing User:", exists);
            return res.status(409).json({ success: false, error: 'User with this email already exists' });
        }

        console.log("[STEP] Creating User");
        const newUser = await User.create({
            name,
            email,
            role,
            profileImage: profileImage || '',
            isActive: true,
            invitedBy: req.user._id,
            createdAt: new Date()
        });
        console.log("[STEP] User Created");

        await creditService.awardCredits(req.user._id, 'ADMIN_USER_APPROVAL', {
            description: `Approved and invited new user: ${newUser.name} (${newUser.role})`
        });

        let emailWarning = null;
        console.log("[STEP] Sending Invitation Email");
        try {
            await emailService.sendAccountCreated(newUser.email, newUser.name, newUser.role);
            console.log("[STEP] Invitation Email Sent");
        } catch (emailErr) {
            console.error("[EMAIL ERROR]", emailErr);
            // If email fails, user is still created, we just warn the client
            emailWarning = "User created but invitation email failed to send.";
        }

        console.log("[CREATE USER] SUCCESS");
        res.status(201).json({
            success: true,
            user: newUser,
            message: emailWarning || "User created successfully",
            warning: !!emailWarning
        });
    } catch (err) {
        console.error("[CREATE USER ERROR]", err);
        handleError(res, err, 'Create User Error');
    }
});

app.patch('/api/admin/users/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        
        const oldIsActive = targetUser.isActive;
        Object.assign(targetUser, req.body);
        await targetUser.save();

        if (req.body.isActive === true && oldIsActive === false) {
            if (targetUser.role === 'author') {
                await creditService.awardCredits(req.user._id, 'ADMIN_AUTHOR_VERIFICATION', {
                    description: `Verified and activated author: ${targetUser.name}`
                });
            } else {
                await creditService.awardCredits(req.user._id, 'ADMIN_USER_APPROVAL', {
                    description: `Approved and activated user: ${targetUser.name}`
                });
            }
        }

        res.json(targetUser);
    } catch (err) {
        handleError(res, err, 'Update User Error');
    }
});

app.delete('/api/admin/users/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        
        if (targetUser._id.toString() === req.user._id.toString()) {
            return res.status(403).json({ error: 'Permission Denied: You cannot delete your own account.' });
        }

        // Allow removing administrative users

        await User.findByIdAndDelete(req.params.id);
        res.json({ message: 'User removed successfully' });
    } catch (err) {
        handleError(res, err, 'Delete User Error');
    }
});

// --- CONTENT MANAGEMENT API ---

app.get('/api/news', async (req, res) => {
    try {
        let filter = { status: 'PUBLISHED' };
        
        if (req.query.search) {
            const searchRegex = new RegExp(req.query.search, 'i');
            filter.$or = [
                { title: searchRegex },
                { content: searchRegex },
                { subtitle: searchRegex },
                { authorName: searchRegex },
                { category: searchRegex }
            ];
            const news = await Article.find(filter).sort({ publishedAt: -1 });
            console.log(`[FETCH NEWS - SEARCH] Found ${news.length} articles matching "${req.query.search}"`);
            return res.json(news);
        } else if (req.query.category && req.query.category.toLowerCase() === 'breaking') {
            filter.$or = [
                { isBreakingNews: true },
                { isMainBreaking: true },
                { isBigBreaking: true }
            ];
            const news = await Article.find(filter).sort({ publishedAt: -1 });
            console.log(`[FETCH NEWS - BREAKING] Found ${news.length} breaking articles`);
            return res.json(news);
        } else if (req.query.category && req.query.category !== 'Home') {
            filter.category = req.query.category;
            const news = await Article.find(filter).sort({ publishedAt: -1 });
            console.log(`[FETCH NEWS - CATEGORY] Found ${news.length} articles for category "${req.query.category}"`);
            return res.json(news);
        } else if (req.query.all === 'true') {
            const news = await Article.find(filter).sort({ publishedAt: -1 });
            console.log(`[FETCH NEWS - ALL] Found ${news.length} articles`);
            return res.json(news);
        } else {
            // Curated Homepage Feed
            const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
            
            // Get Top 10 most viewed published articles
            const top10Articles = await Article.find({ status: 'PUBLISHED' })
                .sort({ views: -1 })
                .limit(10)
                .select('_id');
            const top10Ids = top10Articles.map(a => a._id);
            
            // Build filter for homepage curation:
            // 1. Published in the last 48 hours
            // 2. Or is one of the Top 10 most viewed published articles
            // 3. Or is pinned (for future readiness)
            const homepageFilter = {
                status: 'PUBLISHED',
                $or: [
                    { publishedAt: { $gte: fortyEightHoursAgo } },
                    { _id: { $in: top10Ids } },
                    { isPinned: true }
                ]
            };
            
            const news = await Article.find(homepageFilter).sort({ publishedAt: -1 });
            console.log(`[FETCH NEWS - HOMEPAGE] Found ${news.length} curated articles (48h/trending/pinned)`);
            return res.json(news);
        }
    } catch (err) {
        handleError(res, err, 'Fetch News Error');
    }
});

app.get('/api/articles/:id', async (req, res) => {
    try {
        const idOrSlug = req.params.id;
        let article = null;

        if (mongoose.Types.ObjectId.isValid(idOrSlug)) {
            article = await Article.findById(idOrSlug);
        }

        if (!article) {
            article = await Article.findOne({ slug: idOrSlug });
        }

        if (!article) {
            return res.status(404).json({ success: false, error: 'Article not found' });
        }

        // Safely increment opens count in background without triggering validation on legacy un-updated schema fields
        Article.updateOne({ _id: article._id }, { $inc: { opens: 1 } }).catch(err => {
            console.error('[ARTICLE OPENS INC ERROR]:', err.message);
        });

        return res.json(article);
    } catch (err) {
        console.error('[FETCH ARTICLE ERROR]:', err);
        if (err.stack) {
            console.error(err.stack);
        }
        if (err.name === 'CastError') {
            return res.status(400).json({ success: false, error: 'Invalid article identifier format' });
        }
        return res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
    }
});

app.post('/api/articles/:id/share', async (req, res) => {
    try {
        const idOrSlug = req.params.id;
        let article = null;
        if (mongoose.Types.ObjectId.isValid(idOrSlug)) {
            article = await Article.findById(idOrSlug);
        }
        if (!article) {
            article = await Article.findOne({ slug: idOrSlug });
        }

        if (!article) return res.status(404).json({ error: 'Article not found' });
        
        article.shares += 1;
        await article.save();
        
        // Update Analytics
        await Analytics.findOneAndUpdate(
            { articleId: article._id },
            { $inc: { shares: 1 }, updatedAt: new Date() },
            { upsert: true, new: true }
        );
        
        res.json({ success: true, shares: article.shares });
    } catch (err) {
        handleError(res, err, 'Share Article Error');
    }
});

// LIKE ARTICLE
app.post('/api/articles/:id/like', async (req, res) => {
    try {
        const idOrSlug = req.params.id;
        let article = null;
        if (mongoose.Types.ObjectId.isValid(idOrSlug)) {
            article = await Article.findById(idOrSlug);
        }
        if (!article) {
            article = await Article.findOne({ slug: idOrSlug });
        }

        // Temporary logging for audit
        console.log('[LIKE ARTICLE] req.params.id:', idOrSlug);
        console.log('[LIKE ARTICLE] req.user:', req.user ? { _id: req.user._id, role: req.user.role } : null);
        console.log('[LIKE ARTICLE] article:', article ? { _id: article._id, title: article.title, category: article.category } : null);

        if (!article) return res.status(404).json({ error: 'Article not found' });
        
        article.likes += 1;
        await article.save();
        
        // Update Analytics
        await Analytics.findOneAndUpdate(
            { articleId: article._id },
            { $inc: { likes: 1 }, updatedAt: new Date() },
            { upsert: true, new: true }
        );
        
        res.json({ success: true, likes: article.likes });
    } catch (err) {
        console.error('[LIKE ARTICLE EXCEPTION STACK]:', err);
        if (err.stack) {
            console.error(err.stack);
        }
        res.status(500).json({ 
            error: 'Like Article Error', 
            details: err.message,
            stack: err.stack 
        });
    }
});

// UNLIKE ARTICLE
app.delete('/api/articles/:id/like', async (req, res) => {
    try {
        const idOrSlug = req.params.id;
        let article = null;
        if (mongoose.Types.ObjectId.isValid(idOrSlug)) {
            article = await Article.findById(idOrSlug);
        }
        if (!article) {
            article = await Article.findOne({ slug: idOrSlug });
        }

        // Temporary logging for audit
        console.log('[UNLIKE ARTICLE] req.params.id:', idOrSlug);
        console.log('[UNLIKE ARTICLE] req.user:', req.user ? { _id: req.user._id, role: req.user.role } : null);
        console.log('[UNLIKE ARTICLE] article:', article ? { _id: article._id, title: article.title, category: article.category } : null);

        if (!article) return res.status(404).json({ error: 'Article not found' });
        
        article.likes = Math.max(0, article.likes - 1);
        await article.save();
        
        // Update Analytics
        await Analytics.findOneAndUpdate(
            { articleId: article._id },
            { $inc: { likes: -1 }, updatedAt: new Date() },
            { upsert: true, new: true }
        );
        
        res.json({ success: true, likes: article.likes });
    } catch (err) {
        console.error('[UNLIKE ARTICLE EXCEPTION STACK]:', err);
        if (err.stack) {
            console.error(err.stack);
        }
        res.status(500).json({ 
            error: 'Unlike Article Error', 
            details: err.message,
            stack: err.stack 
        });
    }
});



// GET /api/breaking/main
app.get('/api/breaking/main', async (req, res) => {
    try {
        const breakingNewsHelper = require('./utils/breakingNewsHelper');
        const breaking = await breakingNewsHelper.getCurrentMainBreaking();
        res.json({
            success: true,
            article: breaking || null
        });
    } catch (err) {
        handleError(res, err, 'Fetch Main Breaking Error');
    }
});

// GET /api/breaking/categories
app.get('/api/breaking/categories', async (req, res) => {
    try {
        const breakingNewsHelper = require('./utils/breakingNewsHelper');
        await breakingNewsHelper.cleanupExpiredBreaking();

        const categoriesList = ["Technology", "Business", "Politics", "Sports", "Entertainment", "Science", "Health", "Education", "National", "Global", "Automobile", "Lifestyle", "Movies", "Startups", "Studies", "Case Studies", "Breaking"];
        const now = new Date();
        const articles = await Article.find({
            isCategoryBreaking: { $exists: true, $ne: null },
            categoryBreakingUntil: { $gt: now },
            status: 'PUBLISHED'
        });

        const categoryMap = {};
        for (const cat of categoriesList) {
            const matched = articles.find(a => a.isCategoryBreaking.toLowerCase() === cat.toLowerCase());
            categoryMap[cat] = matched || null;
        }

        res.json({
            success: true,
            categories: categoryMap
        });
    } catch (err) {
        handleError(res, err, 'Fetch Category Breaking News Error');
    }
});

// GET /api/big-breaking
app.get('/api/big-breaking', async (req, res) => {
    try {
        const article = await Article.findOne({ isBigBreaking: true, status: 'PUBLISHED' });
        res.json({
            success: true,
            article: article || null
        });
    } catch (err) {
        handleError(res, err, 'Fetch Big Breaking Error');
    }
});

// PUT /api/admin/big-breaking/:articleId - Assign article as Big Breaking
app.put('/api/admin/big-breaking/:articleId', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { articleId } = req.params;
        const article = await Article.findById(articleId);
        if (!article) {
            return res.status(404).json({ error: 'Article not found' });
        }

        // Find existing and set false
        await Article.updateMany({ isBigBreaking: true }, { $set: { isBigBreaking: false } });

        // Set new article isBigBreaking = true
        article.isBigBreaking = true;
        await article.save();

        // Award admin credits
        await creditService.awardCredits(req.user._id, 'ADMIN_HOMEPAGE_FEATURE', {
            referenceId: article._id,
            description: `Featured article as Big Breaking on homepage: ${article.title}`
        });

        res.json({ success: true, message: 'Article assigned as Big Breaking News', article });
    } catch (err) {
        handleError(res, err, 'Assign Big Breaking Error');
    }
});

// DELETE /api/admin/big-breaking - Remove Big Breaking
app.delete('/api/admin/big-breaking', verifyToken, requireAdmin, async (req, res) => {
    try {
        await Article.updateMany({ isBigBreaking: true }, { $set: { isBigBreaking: false } });
        res.json({ success: true, message: 'Big Breaking News assignment removed' });
    } catch (err) {
        handleError(res, err, 'Remove Big Breaking Error');
    }
});

// PUT /api/admin/breaking/main/:articleId - Assign article as Main Breaking
app.put('/api/admin/breaking/main/:articleId', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { articleId } = req.params;
        const article = await Article.findById(articleId);
        if (!article) {
            return res.status(404).json({ error: 'Article not found' });
        }

        // Clear existing main breaking
        await Article.updateMany(
            { isMainBreaking: true }, 
            { $set: { isMainBreaking: false, mainBreakingUntil: null, isBreakingNews: false } }
        );

        article.isMainBreaking = true;
        article.mainBreakingUntil = new Date(Date.now() + 48 * 60 * 60 * 1000);
        article.isBreakingNews = true;
        await article.save();

        // Award admin credits
        await creditService.awardCredits(req.user._id, 'ADMIN_HOMEPAGE_FEATURE', {
            referenceId: article._id,
            description: `Featured article as Main Breaking on homepage: ${article.title}`
        });

        res.json({ success: true, message: 'Article assigned as Main Breaking News', article });
    } catch (err) {
        handleError(res, err, 'Assign Main Breaking Error');
    }
});

// DELETE /api/admin/breaking/main - Remove Main Breaking
app.delete('/api/admin/breaking/main', verifyToken, requireAdmin, async (req, res) => {
    try {
        await Article.updateMany(
            { isMainBreaking: true }, 
            { $set: { isMainBreaking: false, mainBreakingUntil: null, isBreakingNews: false } }
        );
        res.json({ success: true, message: 'Main Breaking News assignment removed' });
    } catch (err) {
        handleError(res, err, 'Remove Main Breaking Error');
    }
});

// PUT /api/admin/breaking/category/:articleId - Assign article as Category Breaking
app.put('/api/admin/breaking/category/:articleId', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { articleId } = req.params;
        const { category } = req.body;

        const categoriesList = ["Technology", "Business", "Politics", "Sports", "Entertainment", "Science", "Health", "Education", "National", "Global", "Automobile", "Lifestyle", "Movies", "Startups", "Studies", "Case Studies", "Breaking"];
        if (!categoriesList.includes(category)) {
            return res.status(400).json({ error: 'Invalid category for Category Breaking News' });
        }

        const article = await Article.findById(articleId);
        if (!article) {
            return res.status(404).json({ error: 'Article not found' });
        }

        // Clear existing category breaking news for this category
        await Article.updateMany(
            { isCategoryBreaking: category }, 
            { $set: { isCategoryBreaking: null, categoryBreakingUntil: null } }
        );

        article.isCategoryBreaking = category;
        article.categoryBreakingUntil = new Date(Date.now() + 48 * 60 * 60 * 1000);
        await article.save();

        res.json({ success: true, message: `Article assigned as Category Breaking News for ${category}`, article });
    } catch (err) {
        handleError(res, err, 'Assign Category Breaking Error');
    }
});

// DELETE /api/admin/breaking/category/:category - Remove Category Breaking for a category
app.delete('/api/admin/breaking/category/:category', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { category } = req.params;
        await Article.updateMany(
            { isCategoryBreaking: category }, 
            { $set: { isCategoryBreaking: null, categoryBreakingUntil: null } }
        );
        res.json({ success: true, message: `Category Breaking News assignment removed for ${category}` });
    } catch (err) {
        handleError(res, err, 'Remove Category Breaking Error');
    }
});

app.put('/api/admin/articles/:id/breaking', verifyToken, requireAdmin, async (req, res) => {
    try {
        await Article.updateMany({ isBreakingNews: true }, { $set: { isBreakingNews: false } });
        const article = await Article.findByIdAndUpdate(
            req.params.id, 
            { $set: { isBreakingNews: true } },
            { new: true }
        );

        if (article) {
            await creditService.awardCredits(req.user._id, 'ADMIN_HOMEPAGE_FEATURE', {
                referenceId: article._id,
                description: `Featured article on homepage: ${article.title}`
            });
            await creditService.awardCredits(req.user._id, 'ADMIN_PREMIUM_SELECTION', {
                referenceId: article._id,
                description: `Selected premium article: ${article.title}`
            });
        }

        res.json(article);
    } catch (err) {
        handleError(res, err, 'Set Breaking News Error');
    }
});

app.delete('/api/admin/articles/:id/breaking', verifyToken, requireAdmin, async (req, res) => {
    try {
        const article = await Article.findByIdAndUpdate(
            req.params.id, 
            { $set: { isBreakingNews: false, isMainBreaking: false } },
            { new: true }
        );
        res.json(article);
    } catch (err) {
        handleError(res, err, 'Remove Breaking News Error');
    }
});

// Admin Analytics
app.get('/api/admin/analytics', verifyToken, requireAdmin, async (req, res) => {
    try {
        const totalUsers = (await User.countDocuments()) || 0;
        const totalArticles = (await Article.countDocuments()) || 0;
        const publishedArticles = (await Article.countDocuments({ status: 'PUBLISHED' })) || 0;
        const pendingReviews = (await Article.countDocuments({ status: 'PENDING_REVIEW' })) || 0;
        const authors = (await User.countDocuments({ role: 'author' })) || 0;
        const admins = (await User.countDocuments({ role: { $in: ['admin', 'super_admin'] } })) || 0;
        
        const viewStats = await Article.aggregate([
            { $group: { _id: null, totalViews: { $sum: "$views" } } }
        ]);
        const totalViews = viewStats.length > 0 ? viewStats[0].totalViews : 0;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const publishedToday = (await Article.countDocuments({ 
            status: 'PUBLISHED', 
            publishedAt: { $gte: today } 
        })) || 0;

        res.json({
            totalUsers,
            totalViews,
            totalArticles,
            publishedArticles,
            publishedToday,
            totalAuthors: authors,
            totalAdmins: admins,
            pendingReviews
        });
    } catch (err) {
        handleError(res, err, 'Analytics Error');
    }
});

// Security Analytics
app.get('/api/security/stats', verifyToken, requireAdmin, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const totalAdmins = await User.countDocuments({ role: { $in: ['admin', 'super_admin'] } });
        const totalAuthors = await User.countDocuments({ role: 'author' });

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const successfulLoginsToday = await LoginLog.countDocuments({ 
            status: 'success', 
            loginTime: { $gte: today } 
        });

        const failedLoginsToday = await LoginLog.countDocuments({ 
            status: 'failed', 
            loginTime: { $gte: today } 
        });

        const activeSessions = await LoginLog.countDocuments({
            status: 'success',
            logoutTime: { $exists: false },
            loginTime: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
        });

        const latestLogin = await LoginLog.findOne({ status: 'success' }).sort({ loginTime: -1 });

        res.json({
            totalUsers,
            totalAdmins,
            totalAuthors,
            activeSessions,
            successfulLoginsToday,
            failedLoginsToday,
            latestLogin
        });
    } catch (err) {
        handleError(res, err, 'Security Stats Error');
    }
});

app.get('/api/security/logins', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { filter = 'all', page = 1, limit = 20 } = req.query;
        let query = {};

        if (filter === 'admins') {
            query.role = { $in: ['admin', 'super_admin'] };
        } else if (filter === 'authors') {
            query.role = 'author';
        } else if (filter === 'failed') {
            query.status = 'failed';
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const logs = await LoginLog.find(query)
            .sort({ loginTime: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        const total = await LoginLog.countDocuments(query);

        res.json({
            logs,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (err) {
        handleError(res, err, 'Security Logins Error');
    }
});

app.get('/api/admin/pending',
 verifyToken, requireReviewer, async (req, res) => {
    try {
        const articles = await Article.find({ 
            status: { $in: ['PENDING_REVIEW', 'REVISION_REQUESTED'] } 
        }).sort({ updatedAt: -1 });
        res.json(articles);
    } catch (err) {
        handleError(res, err, 'Fetch Pending Error');
    }
});

app.patch('/api/admin/articles/:id', verifyToken, requireEditor, async (req, res) => {
    try {
        const article = await Article.findById(req.params.id);
        if (!article) return res.status(404).json({ error: 'Article not found' });
        
        const oldStatus = article.status;
        Object.assign(article, req.body);
        
        // Generate and apply SEO defaults if empty
        const seoData = await applySeoDefaults(article, article._id);
        Object.assign(article, seoData);
        
        article.updatedAt = new Date();

        if (req.body.status === 'PUBLISHED' && !article.publishedAt) {
            article.publishedAt = new Date();
        }

        if (['APPROVED', 'PUBLISHED', 'REVISION_REQUESTED', 'REJECTED'].includes(req.body.status)) {
            article.reviewedAt = new Date();
            article.reviewedBy = req.user.name;
        }
        
        await article.save();

        if (['APPROVED', 'PUBLISHED'].includes(req.body.status) && !['APPROVED', 'PUBLISHED'].includes(oldStatus)) {
            await creditService.awardCredits(req.user._id, 'ADMIN_ARTICLE_REVIEW', {
                referenceId: article._id,
                description: `Reviewed article: ${article.title}`
            });
            await creditService.awardCredits(req.user._id, 'ADMIN_ARTICLE_APPROVAL', {
                referenceId: article._id,
                description: `Approved article: ${article.title}`
            });
        } else if (req.body.status === 'REVISION_REQUESTED' && oldStatus !== 'REVISION_REQUESTED') {
            await creditService.awardCredits(req.user._id, 'ADMIN_ARTICLE_REVIEW', {
                referenceId: article._id,
                description: `Issued revision directives for article: ${article.title}`
            });
        }

        if (article.status === 'PUBLISHED' && oldStatus !== 'PUBLISHED') {
            await creditService.processArticlePublish(article);
        }

        // Trigger status email notification asynchronously (do not block client/response)
        emailService.checkAndSendArticleStatusEmail(
            article,
            oldStatus,
            article.status,
            req.user.name,
            req.body.revisionMessage || req.body.reviewComments
        ).catch(err => console.error('[SMTP] Failed in checkAndSendArticleStatusEmail:', err));

        res.json(article);
    } catch (err) {
        handleError(res, err, 'Update Article Error');
    }
});

app.delete('/api/admin/articles/:id', verifyToken, requireEditor, async (req, res) => {
    try {
        console.log(`[DELETE] Request for Article ID: ${req.params.id} by ${req.user.email}`);
        const article = await Article.findById(req.params.id);
        
        if (!article) {
            console.log(`[DELETE] Failure: Article ${req.params.id} not found.`);
            return res.status(404).json({ success: false, error: 'Article not found' });
        }

        // Negate credits associated with the article
        await creditService.processArticleDelete(article._id);

        await Article.findByIdAndDelete(req.params.id);
        console.log(`[DELETE] Success: Article ${req.params.id} purged.`);
        res.json({ success: true, message: 'Article deleted successfully' });
    } catch (err) {
        console.error(`[DELETE] Database Error:`, err);
        handleError(res, err, 'Delete Article Error');
    }
});

// Author/Admin APIs
app.get('/api/articles', verifyToken, async (req, res) => {
    try {
        console.log('--- ADMIN FETCH ARTICLES ROUTE ---');
        console.log('User identity:', req.user.email, '| Clearance:', req.user.role);
        
        // Diagnostic Check: Mongoose Connection State
        if (mongoose.connection.readyState !== 1) {
            throw new Error(`Database connection is not ready. Mongoose readyState is ${mongoose.connection.readyState}`);
        }

        // Diagnostic Check: Registered model existence
        if (!mongoose.modelNames().includes('Article')) {
            throw new Error('Database model validation failed: "Article" model is not loaded or missing.');
        }

        const articles = await Article.find().sort({ updatedAt: -1 });
        res.json(articles);
    } catch (err) {
        console.error('[API ROUTE FAILURE] GET /api/articles failed:', err);
        handleError(res, err, 'Fetch Articles Error');
    }
});

app.get('/api/my-articles', verifyToken, async (req, res) => {
    try {
        console.log('--- MY ARTICLES ROUTE ---');
        console.log('User identity:', req.user.email, '| Clearance:', req.user.role);
        
        // Diagnostic Check: Mongoose Connection State
        if (mongoose.connection.readyState !== 1) {
            throw new Error(`Database connection is not ready. Mongoose readyState is ${mongoose.connection.readyState}`);
        }

        // Diagnostic Check: Registered model existence
        if (!mongoose.modelNames().includes('Article')) {
            throw new Error('Database model validation failed: "Article" model is not loaded or missing.');
        }

        const filter = req.user.role === 'author' ? { authorId: req.user._id } : {};
        const articles = await Article.find(filter).sort({ updatedAt: -1 });
        res.json(articles);
    } catch (err) {
        console.error('[API ROUTE FAILURE] GET /api/my-articles failed:', err);
        handleError(res, err, 'Fetch My Articles Error');
    }
});

const isReviewStatus = (status) => {
    if (!status) return false;
    const normalized = status.toString().toLowerCase();
    return normalized === 'pending' || normalized === 'submitted_for_review' || normalized === 'pending_review';
};

app.patch('/api/articles/:id', verifyToken, async (req, res) => {
    try {
        const article = await Article.findById(req.params.id);
        if (!article) return res.status(404).json({ error: 'Article not found' });

        // Authorization: Only owner or admin/editor can update
        const isOwner = article.authorId.toString() === req.user._id.toString();
        const isAdmin = ['admin', 'super_admin', 'editor'].includes(req.user.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Permission Denied: You can only update your own articles.' });
        }

        // Backend Authorization check for article status changes (preventing privilege escalation)
        if (req.body.status && req.body.status !== article.status) {
            const adminRoles = ['admin', 'super_admin', 'editor', 'reviewer'];
            const isTargetAdminStatus = ['APPROVED', 'PUBLISHED', 'REVISION_REQUESTED', 'REJECTED'].includes(req.body.status.toUpperCase());
            const isAdminUser = adminRoles.includes(req.user.role);
            
            if (isTargetAdminStatus && !isAdminUser) {
                return res.status(403).json({ error: 'Permission Denied: Only editors or administrators can approve, publish, reject, or request revisions.' });
            }
        }

        console.log(`[UPDATE ARTICLE] ID: ${req.params.id} | Payload:`, JSON.stringify(req.body, null, 2));

        const oldStatus = article.status;
        Object.assign(article, req.body);
        
        // Generate and apply SEO defaults if empty
        const seoData = await applySeoDefaults(article, article._id);
        Object.assign(article, seoData);
        
        article.updatedAt = new Date();
        await article.save();

        // Notification logic for editorial workflow
        if (article.status === 'PENDING_REVIEW') {
            if (oldStatus === 'DRAFT') {
                await createAdminNotification(
                    'Article Submitted for Review',
                    `${req.user.name} submitted an article for review.`
                );
            } else if (oldStatus === 'PENDING_REVIEW') {
                await createAdminNotification(
                    'Submitted Article Updated',
                    `${req.user.name} updated an article awaiting approval.`
                );
            } else if (oldStatus === 'REJECTED' || oldStatus === 'REVISION_REQUESTED') {
                await createAdminNotification(
                    'Article Resubmitted',
                    `${req.user.name} resubmitted an article after revisions.`
                );
            }
        }

        // Email notification trigger for review submissions
        if (isReviewStatus(article.status) && !isReviewStatus(oldStatus)) {
            try {
                await emailService.sendArticleReviewNotification(article);
            } catch (emailErr) {
                console.error('[ARTICLE REVIEW] Error sending notification email on update:', emailErr);
            }
        }

        // Trigger status email notification asynchronously (do not block client/response)
        emailService.checkAndSendArticleStatusEmail(
            article,
            oldStatus,
            article.status,
            req.user.name,
            req.body.revisionMessage || req.body.reviewComments
        ).catch(err => console.error('[SMTP] Failed in checkAndSendArticleStatusEmail:', err));

        res.json(article);
    } catch (err) {
        handleError(res, err, 'Update Article Generic Error');
    }
});

app.post('/api/articles', verifyToken, async (req, res) => {
    try {
        console.log(`[CREATE ARTICLE] Request Body:`, JSON.stringify(req.body, null, 2));
        if (!['author', 'admin', 'super_admin'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Permission Denied: Insufficient clearance to create articles.' });
        }

        // Backend Authorization check for creating articles with administrative status (preventing privilege escalation)
        if (req.body.status) {
            const adminRoles = ['admin', 'super_admin', 'editor', 'reviewer'];
            const isTargetAdminStatus = ['APPROVED', 'PUBLISHED', 'REVISION_REQUESTED', 'REJECTED'].includes(req.body.status.toUpperCase());
            const isAdminUser = adminRoles.includes(req.user.role);
            
            if (isTargetAdminStatus && !isAdminUser) {
                return res.status(403).json({ error: 'Permission Denied: Only editors or administrators can create articles with an approved or published status.' });
            }
        }

        const seoData = await applySeoDefaults(req.body);
        const newArticle = await Article.create({
            ...req.body,
            ...seoData,
            authorId: req.user._id,
            authorName: req.user.name,
            createdAt: new Date(),
            updatedAt: new Date()
        });

        if (newArticle.status === 'PUBLISHED') {
            await creditService.processArticlePublish(newArticle);
        }

        // Notification logic for editorial workflow
        if (newArticle.status === 'PENDING_REVIEW') {
            await createAdminNotification(
                'New Article Submitted',
                `${req.user.name} submitted an article for review.`
            );
        }

        // Email notification trigger for review submissions
        if (isReviewStatus(newArticle.status)) {
            try {
                await emailService.sendArticleReviewNotification(newArticle);
            } catch (emailErr) {
                console.error('[ARTICLE REVIEW] Error sending notification email on create:', emailErr);
            }
        }

        res.status(201).json(newArticle);
    } catch (err) {
        handleError(res, err, 'Create Article Error');
    }
});

// Storage API
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/upload', verifyToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        
        const uploadType = req.query.type || 'article';
        let result;
        
        if (uploadType === 'admin') {
            result = await uploadProfileImage(req.file.buffer, 'newspercent/profiles/admins');
        } else if (uploadType === 'author') {
            result = await uploadProfileImage(req.file.buffer, 'newspercent/profiles/authors');
        } else if (uploadType === 'breaking-news') {
            result = await uploadArticleImage(req.file.buffer, 'newspercent/breaking-news');
        } else if (uploadType === 'flash-news') {
            result = await uploadArticleImage(req.file.buffer, 'newspercent/flash-news');
        } else {
            // default to article/content
            result = await uploadArticleImage(req.file.buffer, 'newspercent/articles');
        }
        
        res.json({ success: true, imageUrl: result.secure_url, publicId: result.public_id });
    } catch (err) {
        handleError(res, err, 'Upload Error');
    }
});

// --- CREDIT SYSTEM API ---

app.get('/api/credits/me', verifyToken, async (req, res) => {
    try {
        const stats = await User.aggregate([
            { $match: { _id: new mongoose.Types.ObjectId(req.user._id) } },
            {
                $addFields: { userIdString: { $toString: "$_id" } }
            },
            {
                $lookup: {
                    from: 'articles',
                    localField: 'userIdString',
                    foreignField: 'authorId',
                    as: 'userArticles'
                }
            },
            {
                $addFields: {
                    publishedArticles: {
                        $filter: {
                            input: "$userArticles",
                            as: "art",
                            cond: { $eq: ["$$art.status", "PUBLISHED"] }
                        }
                    }
                }
            },
            {
                $project: {
                    name: 1, email: 1, role: 1, profileImage: 1,
                    totalCredits: 1, monthlyCredits: 1, yearlyCredits: 1,
                    badges: 1, achievements: 1,
                    articlesPublished: { $size: "$publishedArticles" },
                    totalViews: { $sum: "$publishedArticles.views" }
                }
            }
        ]);

        if (!stats.length) return res.status(404).json({ error: 'User not found' });
        
        const user = stats[0];
        const rankingScore = creditService.calculateRankingScore(user);
        res.json({ ...user, rankingScore });
    } catch (err) {
        handleError(res, err, 'Fetch My Credits Error');
    }
});

app.get('/api/credits/leaderboard', async (req, res) => {
    try {
        const leaderboard = await User.aggregate([
            { $match: { totalCredits: { $gt: 0 } } },
            {
                $addFields: { userIdString: { $toString: "$_id" } }
            },
            {
                $lookup: {
                    from: 'articles',
                    localField: 'userIdString',
                    foreignField: 'authorId',
                    as: 'userArticles'
                }
            },
            {
                $addFields: {
                    publishedArticles: {
                        $filter: {
                            input: "$userArticles",
                            as: "art",
                            cond: { $eq: ["$$art.status", "PUBLISHED"] }
                        }
                    }
                }
            },
            {
                $project: {
                    name: 1, role: 1, totalCredits: 1, badges: 1,
                    articlesPublished: { $size: "$publishedArticles" },
                    totalViews: { $sum: "$publishedArticles.views" }
                }
            },
            { $sort: { totalCredits: -1 } },
            { $limit: 50 }
        ]);
        
        const enriched = leaderboard.map(u => ({
            ...u,
            rankingScore: creditService.calculateRankingScore(u)
        }));

        res.json(enriched);
    } catch (err) {
        handleError(res, err, 'Leaderboard Error');
    }
});

app.get('/api/credits/history/:userId', verifyToken, async (req, res) => {
    try {
        const history = await CreditTransaction.find({ userId: req.params.userId })
            .sort({ createdAt: -1 })
            .limit(100);
        res.json(history);
    } catch (err) {
        handleError(res, err, 'Credit History Error');
    }
});

// --- EXPORT API (ADMIN ONLY) ---

app.get('/api/admin/export/article/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
        const settings = await settingsService.getSettings();
        if (!settings.documentExportEnabled) {
            return res.status(403).json({ error: 'Document export is currently disabled by the administrator.' });
        }

        const article = await Article.findById(req.params.id);
        if (!article) return res.status(404).json({ error: 'Article not found' });

        const buffer = await exportService.generateArticleDoc(article, req.user);
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${article.title.replace(/[^a-z0-9]/gi, '_')}.docx"`);
        res.send(buffer);
    } catch (err) {
        handleError(res, err, 'Article Export Error');
    }
});

// --- SYSTEM SETTINGS API ---

app.get('/api/settings/public', async (req, res) => {
    try {
        const settings = await settingsService.getSettings();
        // Return safe public flags
        res.json({
            // Legacy mapping
            creditSystemEnabled: settings.performanceCreditsEnabled,
            exportSystemEnabled: settings.documentExportEnabled,
            externalApisEnabled: settings.externalApisEnabled,
            analyticsEnabled: settings.analyticsEnabled,

            // New settings
            performanceCreditsEnabled: settings.performanceCreditsEnabled,
            documentExportEnabled: settings.documentExportEnabled,
            weatherApiEnabled: settings.weatherApiEnabled,
            marketApiEnabled: settings.marketApiEnabled,
            populationApiEnabled: settings.populationApiEnabled,
            emailServiceEnabled: settings.emailServiceEnabled,
            preciousMetalsApiEnabled: settings.preciousMetalsApiEnabled,
            fuelApiEnabled: settings.fuelApiEnabled,
            emergencyMode: settings.emergencyMode
        });
    } catch (err) {
        handleError(res, err, 'Fetch Public Settings Error');
    }
});

// --- CREDIT CONFIGURATION APIs ---
app.get('/api/admin/settings/credits', verifyToken, requireAdmin, async (req, res) => {
    try {
        const CreditConfig = require('./models/CreditConfig');
        let config = await CreditConfig.findOne();
        if (!config) {
            config = new CreditConfig({
                maxContentCredits: 40,
                maxResearchCredits: 30,
                maxSeoCredits: 10,
                maxHeadlineCredits: 10,
                maxImageCredits: 10,
                maxPublishingCredits: 10,
                defaultPublishingCredits: 5,
                maxTotalCredits: 120
            });
            await config.save();
        }
        res.json({ success: true, data: config });
    } catch (err) {
        handleError(res, err, 'Fetch Credit Config Error');
    }
});

app.put('/api/admin/settings/credits', verifyToken, requireAdmin, async (req, res) => {
    try {
        const CreditConfig = require('./models/CreditConfig');
        let config = await CreditConfig.findOne();
        if (!config) {
            config = new CreditConfig();
        }
        
        const { 
            maxContentCredits, 
            maxResearchCredits, 
            maxSeoCredits, 
            maxHeadlineCredits, 
            maxImageCredits, 
            maxPublishingCredits, 
            defaultPublishingCredits, 
            maxTotalCredits 
        } = req.body;

        config.maxContentCredits = maxContentCredits !== undefined ? Number(maxContentCredits) : config.maxContentCredits;
        config.maxResearchCredits = maxResearchCredits !== undefined ? Number(maxResearchCredits) : config.maxResearchCredits;
        config.maxSeoCredits = maxSeoCredits !== undefined ? Number(maxSeoCredits) : config.maxSeoCredits;
        config.maxHeadlineCredits = maxHeadlineCredits !== undefined ? Number(maxHeadlineCredits) : config.maxHeadlineCredits;
        config.maxImageCredits = maxImageCredits !== undefined ? Number(maxImageCredits) : config.maxImageCredits;
        config.maxPublishingCredits = maxPublishingCredits !== undefined ? Number(maxPublishingCredits) : config.maxPublishingCredits;
        config.defaultPublishingCredits = defaultPublishingCredits !== undefined ? Number(defaultPublishingCredits) : config.defaultPublishingCredits;
        config.maxTotalCredits = maxTotalCredits !== undefined ? Number(maxTotalCredits) : config.maxTotalCredits;

        await config.save();
        res.json({ success: true, data: config });
    } catch (err) {
        handleError(res, err, 'Update Credit Config Error');
    }
});

app.get('/api/admin/settings', verifyToken, requireAdmin, async (req, res) => {
    try {
        const settings = await settingsService.getSettings();
        res.json(settings);
    } catch (err) {
        handleError(res, err, 'Fetch Admin Settings Error');
    }
});

app.patch('/api/admin/settings', verifyToken, requireSuperAdmin, async (req, res) => {
    try {
        const settings = await settingsService.updateSettings(req.body, req.user._id);
        
        await creditService.awardCredits(req.user._id, 'ADMIN_COMMUNITY_MGMT', {
            description: 'Updated system-wide credit and operational parameters'
        });
        await creditService.awardCredits(req.user._id, 'ADMIN_SUPPORT_RESOLUTION', {
            description: 'Resolved configuration and system parameters update requests'
        });

        res.json(settings);
    } catch (err) {
        handleError(res, err, 'Update Settings Error');
    }
});

// --- EXTERNAL API CONFIGURATION ENDPOINTS ---
const ExternalApiConfig = require('./models/ExternalApiConfig');

// Get active external API configurations and lists
app.get('/api/admin/external-apis', verifyToken, requireAdmin, async (req, res) => {
    try {
        const weatherConfig = await ExternalApiConfig.findOne({ serviceName: 'Weather API', status: 'ACTIVE' }).sort({ startDate: -1 });
        const stockConfig = await ExternalApiConfig.findOne({ serviceName: 'Stock Market API', status: 'ACTIVE' }).sort({ startDate: -1 });
        const preciousMetalsConfig = await ExternalApiConfig.findOne({ serviceName: 'Precious Metals API', status: 'ACTIVE' }).sort({ startDate: -1 });
        const fuelConfig = await ExternalApiConfig.findOne({ serviceName: 'Fuel API', status: 'ACTIVE' }).sort({ startDate: -1 });

        const settings = await settingsService.getSettings();

        // Helper to format/mask keys and include diagnostics
        const formatConfig = (config, defaultEnabled, defaultProvider, service) => {
            const isWeather = service === 'Weather API';
            const isPreciousMetals = service === 'Precious Metals API';
            const isFuel = service === 'Fuel API';
            const isMaskable = isWeather || isPreciousMetals || isFuel;

            if (!config) {
                let hasEnv = false;
                if (isWeather) hasEnv = !!(process.env.WEATHER_API_KEY || process.env.VITE_WEATHER_API_KEY);
                if (isPreciousMetals) hasEnv = !!(process.env.PRECIOUS_METALS_API_KEY || process.env.VITE_PRECIOUS_METALS_API_KEY || process.env.GOLD_API_KEY || process.env.VITE_GOLD_API_KEY);
                if (isFuel) hasEnv = !!(process.env.FUEL_API_KEY || process.env.VITE_FUEL_API_KEY);

                return {
                    provider: defaultProvider,
                    apiKeyMasked: isMaskable ? (hasEnv ? 'Env Variable Set' : 'Default Preset') : 'N/A',
                    status: defaultEnabled ? 'CONNECTED' : 'DISCONNECTED',
                    enabled: defaultEnabled,
                    registered: null,
                    lastTested: null,
                    lastHttpStatus: null,
                    lastResponseMsg: null,
                    source: isMaskable ? (hasEnv ? 'Environment Variable' : 'Default Preset') : 'Library Integrated'
                };
            }

            let apiKeyMasked = 'N/A';
            let source = 'Library Integrated';
            if (isMaskable) {
                if (config.apiKey) {
                    const dec = decrypt(config.apiKey);
                    if (dec) {
                        if (dec.length > 8) {
                            apiKeyMasked = dec.substring(0, 4) + '*'.repeat(12) + dec.substring(dec.length - 3);
                        } else {
                            apiKeyMasked = dec.substring(0, 2) + '*'.repeat(6) + dec.substring(dec.length - 1);
                        }
                    }
                    source = 'Database (Encrypted)';
                } else {
                    let hasEnv = false;
                    if (isWeather) hasEnv = !!(process.env.WEATHER_API_KEY || process.env.VITE_WEATHER_API_KEY);
                    if (isPreciousMetals) hasEnv = !!(process.env.PRECIOUS_METALS_API_KEY || process.env.VITE_PRECIOUS_METALS_API_KEY || process.env.GOLD_API_KEY || process.env.VITE_GOLD_API_KEY);
                    if (isFuel) hasEnv = !!(process.env.FUEL_API_KEY || process.env.VITE_FUEL_API_KEY);

                    apiKeyMasked = hasEnv ? 'Env Variable Set' : 'Default Preset';
                    source = hasEnv ? 'Environment Variable' : 'Default Preset';
                }
            }

            return {
                _id: config._id,
                provider: config.provider,
                apiKeyMasked,
                status: config.status === 'ACTIVE' ? 'CONNECTED' : 'DISCONNECTED',
                enabled: config.enabled,
                registered: config.startDate,
                lastTested: config.lastTested || config.updatedAt,
                lastHttpStatus: config.lastHttpStatus || null,
                lastResponseMsg: config.lastResponseMsg || null,
                source
            };
        };

        const weatherActive = formatConfig(weatherConfig, settings.weatherApiEnabled, 'WeatherAPI', 'Weather API');
        const stockActive = formatConfig(stockConfig, settings.marketApiEnabled, 'Yahoo Finance', 'Stock Market API');
        const preciousMetalsActive = formatConfig(preciousMetalsConfig, settings.preciousMetalsApiEnabled, 'GoldAPI.io', 'Precious Metals API');
        const fuelActive = formatConfig(fuelConfig, settings.fuelApiEnabled, 'm2c Fuel API', 'Fuel API');

        const allConfigs = await ExternalApiConfig.find().sort({ startDate: -1 });

        res.json({
            weatherActive,
            stockActive,
            preciousMetalsActive,
            fuelActive,
            allConfigs
        });
    } catch (err) {
        handleError(res, err, 'Fetch External APIs Error');
    }
});

// Test proposed API Key connection
app.post('/api/admin/external-apis/verify', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { serviceName, provider, apiKey } = req.body;
        if (!serviceName || !provider) {
            return res.status(400).json({ error: 'Service name and provider are required.' });
        }

        if (serviceName === 'Weather API') {
            let keyToTest = apiKey;

            // Resolve actual key if it's masked or N/A or empty
            const isMaskedOrNa = !keyToTest || keyToTest === 'N/A' || keyToTest.includes('*');
            let activeConfig = null;
            
            if (isMaskedOrNa) {
                activeConfig = await ExternalApiConfig.findOne({ serviceName: 'Weather API', status: 'ACTIVE' });
                if (activeConfig && activeConfig.apiKey) {
                    const dec = decrypt(activeConfig.apiKey);
                    if (dec) {
                        keyToTest = dec;
                    }
                }
            }

            if (!keyToTest || keyToTest === 'N/A' || keyToTest.includes('*')) {
                // Fallback to env key
                keyToTest = process.env.WEATHER_API_KEY || process.env.VITE_WEATHER_API_KEY || '71e7436123ba4731a9b191053261906';
            }

            const axios = require('axios');
            const url = `https://api.weatherapi.com/v1/forecast.json?key=${keyToTest}&q=London&days=1`;
            const redactedUrl = url.replace(keyToTest, '***REDACTED***');
            
            console.log('--- WEATHER API CONNECTION TEST ---');
            console.log(`Provider: ${provider}`);
            console.log(`Endpoint URL: ${redactedUrl}`);

            try {
                const apiRes = await axios.get(url, { timeout: 6000 });
                console.log(`HTTP Status Code: ${apiRes.status}`);
                console.log(`Response Body:`, JSON.stringify(apiRes.data).substring(0, 1000));
                
                // If we are testing the current active key, update DB diagnostics
                if (isMaskedOrNa) {
                    const activeDoc = await ExternalApiConfig.findOne({ serviceName: 'Weather API', status: 'ACTIVE' });
                    if (activeDoc) {
                        activeDoc.lastTested = Date.now();
                        activeDoc.lastHttpStatus = apiRes.status;
                        activeDoc.lastResponseMsg = 'OK - Weather verified';
                        await activeDoc.save();
                    }
                }

                res.json({ success: true, message: 'Weather API connection verified successfully.' });
            } catch (apiErr) {
                const status = apiErr.response ? apiErr.response.status : null;
                const responseBody = apiErr.response ? apiErr.response.data : null;
                
                console.log(`HTTP Status Code: ${status || 'Network Error/No Status'}`);
                console.log(`Response Body:`, responseBody ? JSON.stringify(responseBody) : apiErr.message);

                // Map status codes to custom errors
                let errorMsg = 'Connection test failed.';
                if (status === 401) {
                    errorMsg = 'Invalid API Key';
                } else if (status === 403) {
                    errorMsg = 'API quota exceeded';
                } else if (status === 429) {
                    errorMsg = 'Rate limit exceeded';
                } else if (status && status >= 500) {
                    errorMsg = 'Provider temporarily unavailable';
                } else {
                    errorMsg = apiErr.message || 'Connection test failed.';
                }

                // If we are testing the current active key, update DB diagnostics
                if (isMaskedOrNa) {
                    const activeDoc = await ExternalApiConfig.findOne({ serviceName: 'Weather API', status: 'ACTIVE' });
                    if (activeDoc) {
                        activeDoc.lastTested = Date.now();
                        activeDoc.lastHttpStatus = status || 500;
                        activeDoc.lastResponseMsg = errorMsg;
                        await activeDoc.save();
                    }
                }

                return res.status(400).json({ error: errorMsg });
            }
        } else if (serviceName === 'Stock Market API') {
            const activeConfig = await ExternalApiConfig.findOne({ serviceName: 'Stock Market API', status: 'ACTIVE' });
            
            console.log('--- STOCK MARKET API CONNECTION TEST ---');
            console.log(`Provider: ${provider}`);
            console.log(`Endpoint URL: Yahoo Finance API (yahoo-finance2 library wrapper)`);
            
            try {
                const YahooFinance = require('yahoo-finance2').default;
                const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
                const quoteRes = await yahooFinance.quote(['AAPL']);
                
                console.log(`HTTP Status Code: 200`);
                console.log(`Response Body:`, JSON.stringify(quoteRes).substring(0, 1000));
                
                if (activeConfig) {
                    activeConfig.lastTested = Date.now();
                    activeConfig.lastHttpStatus = 200;
                    activeConfig.lastResponseMsg = 'OK - Stock verified';
                    await activeConfig.save();
                }
                
                res.json({ success: true, message: 'Stock Market API connection verified successfully.' });
            } catch (apiErr) {
                console.log(`HTTP Status Code: 500`);
                console.log(`Response Body:`, apiErr.message);
                
                if (activeConfig) {
                    activeConfig.lastTested = Date.now();
                    activeConfig.lastHttpStatus = 500;
                    activeConfig.lastResponseMsg = apiErr.message || 'Connection test failed.';
                    await activeConfig.save();
                }
                
                return res.status(400).json({ error: `Connection test failed: ${apiErr.message}` });
            }
        } else if (serviceName === 'Precious Metals API') {
            let keyToTest = apiKey;
            const isMaskedOrNa = !keyToTest || keyToTest === 'N/A' || keyToTest.includes('*');
            let activeConfig = null;
            
            if (isMaskedOrNa) {
                activeConfig = await ExternalApiConfig.findOne({ serviceName: 'Precious Metals API', status: 'ACTIVE' });
                if (activeConfig && activeConfig.apiKey) {
                    const dec = decrypt(activeConfig.apiKey);
                    if (dec) {
                        keyToTest = dec;
                    }
                }
            }

            if (!keyToTest || keyToTest === 'N/A' || keyToTest.includes('*')) {
                keyToTest = process.env.PRECIOUS_METALS_API_KEY || process.env.GOLD_API_KEY || 'goldapi-e534f854ad9d063b91a413673b705ee7-io';
            }

            let maskedKeyLog = 'N/A';
            if (keyToTest && keyToTest.length > 8) {
                maskedKeyLog = keyToTest.substring(0, 4) + '*'.repeat(16) + keyToTest.substring(keyToTest.length - 4);
            } else if (keyToTest) {
                maskedKeyLog = keyToTest.substring(0, 2) + '*'.repeat(8) + keyToTest.substring(keyToTest.length - 1);
            }

            const axios = require('axios');
            const url = `https://www.goldapi.io/api/XAU/USD`;
            
            console.log(`--- PRECIOUS METALS API CONNECTION TEST ---`);
            console.log(`Provider: ${provider}`);
            console.log(`API Key: ${maskedKeyLog}`);
            console.log(`Endpoint URL: ${url}`);

            try {
                const apiRes = await axios.get(url, {
                    headers: { 'x-access-token': keyToTest },
                    timeout: 6000
                });
                console.log(`HTTP Status Code: ${apiRes.status}`);
                
                if (isMaskedOrNa) {
                    const activeDoc = await ExternalApiConfig.findOne({ serviceName: 'Precious Metals API', status: 'ACTIVE' });
                    if (activeDoc) {
                        activeDoc.lastTested = Date.now();
                        activeDoc.lastHttpStatus = apiRes.status;
                        activeDoc.lastResponseMsg = `OK - Precious Metals verified`;
                        await activeDoc.save();
                    }
                }

                res.json({ success: true, message: `Precious Metals API connection verified successfully.` });
            } catch (apiErr) {
                const status = apiErr.response ? apiErr.response.status : null;
                const responseBody = apiErr.response ? apiErr.response.data : null;
                
                console.log(`HTTP Status Code: ${status || 'Network Error/No Status'}`);
                console.log(`Response Body:`, responseBody ? JSON.stringify(responseBody) : apiErr.message);

                let actualError = '';
                if (responseBody) {
                    if (typeof responseBody === 'string') {
                        actualError = responseBody;
                    } else if (responseBody.error) {
                        actualError = responseBody.error;
                    } else if (responseBody.message) {
                        actualError = responseBody.message;
                    } else {
                        actualError = JSON.stringify(responseBody);
                    }
                }

                let errorMsg = 'Connection test failed.';
                if (status === 401 || status === 403) {
                    errorMsg = actualError || 'Invalid API Key / Access Denied';
                } else if (status === 429) {
                    errorMsg = actualError || 'Rate limit exceeded';
                } else {
                    errorMsg = actualError || apiErr.message || 'Connection test failed.';
                }

                if (isMaskedOrNa) {
                    const activeDoc = await ExternalApiConfig.findOne({ serviceName: 'Precious Metals API', status: 'ACTIVE' });
                    if (activeDoc) {
                        activeDoc.lastTested = Date.now();
                        activeDoc.lastHttpStatus = status || 500;
                        activeDoc.lastResponseMsg = errorMsg;
                        await activeDoc.save();
                    }
                }

                return res.status(400).json({ error: errorMsg });
            }
        } else if (serviceName === 'Fuel API') {
            let keyToTest = apiKey;
            const isMaskedOrNa = !keyToTest || keyToTest === 'N/A' || keyToTest.includes('*');
            let activeConfig = null;
            
            if (isMaskedOrNa) {
                activeConfig = await ExternalApiConfig.findOne({ serviceName: 'Fuel API', status: 'ACTIVE' });
                if (activeConfig && activeConfig.apiKey) {
                    const dec = decrypt(activeConfig.apiKey);
                    if (dec) {
                        keyToTest = dec;
                    }
                }
            }

            if (!keyToTest || keyToTest === 'N/A' || keyToTest.includes('*')) {
                keyToTest = process.env.FUEL_API_KEY || 'sk-live-kL3JzfGtjyqvUIYFxHDAHZuadiFiQjyTMt8nO0bG';
            }

            const axios = require('axios');
            const url = `https://fuel.indianapi.in/live_fuel_price?fuel_type=petrol&location_type=state`;
            
            console.log(`--- FUEL API CONNECTION TEST ---`);
            console.log(`Provider: ${provider}`);
            console.log(`Endpoint URL: ${url}`);

            try {
                const apiRes = await axios.get(url, {
                    headers: { 'x-api-key': keyToTest },
                    timeout: 6000
                });
                console.log(`HTTP Status Code: ${apiRes.status}`);
                
                if (isMaskedOrNa) {
                    const activeDoc = await ExternalApiConfig.findOne({ serviceName: 'Fuel API', status: 'ACTIVE' });
                    if (activeDoc) {
                        activeDoc.lastTested = Date.now();
                        activeDoc.lastHttpStatus = apiRes.status;
                        activeDoc.lastResponseMsg = `OK - Fuel verified`;
                        await activeDoc.save();
                    }
                }

                res.json({ success: true, message: `Fuel API connection verified successfully.` });
            } catch (apiErr) {
                const status = apiErr.response ? apiErr.response.status : null;
                const responseBody = apiErr.response ? apiErr.response.data : null;
                
                console.log(`HTTP Status Code: ${status || 'Network Error/No Status'}`);
                console.log(`Response Body:`, responseBody ? JSON.stringify(responseBody) : apiErr.message);

                let errorMsg = 'Connection test failed.';
                if (status === 401 || status === 403) {
                    errorMsg = 'Invalid API Key / Access Denied';
                } else if (status === 429) {
                    errorMsg = 'Rate limit exceeded';
                } else {
                    errorMsg = apiErr.message || 'Connection test failed.';
                }

                if (isMaskedOrNa) {
                    const activeDoc = await ExternalApiConfig.findOne({ serviceName: 'Fuel API', status: 'ACTIVE' });
                    if (activeDoc) {
                        activeDoc.lastTested = Date.now();
                        activeDoc.lastHttpStatus = status || 500;
                        activeDoc.lastResponseMsg = errorMsg;
                        await activeDoc.save();
                    }
                }

                return res.status(400).json({ error: errorMsg });
            }
        } else {
            // Future / custom APIs
            return res.json({ success: true, message: `${serviceName} connection verified successfully (custom verification bypassed).` });
        }
    } catch (err) {
        handleError(res, err, 'Verify External API Error');
    }
});

// Rotate API Key / Activate new credentials
app.post('/api/admin/external-apis/rotate', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { serviceName, provider, apiKey, reason } = req.body;
        if (!serviceName || !provider) {
            return res.status(400).json({ error: 'Service name and provider are required.' });
        }

        let lastHttpStatus = 200;
        let lastResponseMsg = 'Newly activated credentials';

        if (serviceName === 'Weather API') {
            if (!apiKey) {
                return res.status(400).json({ error: 'API key is required to rotate Weather API.' });
            }
            const axios = require('axios');
            try {
                const url = `https://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=London&days=1`;
                await axios.get(url, { timeout: 6000 });
                lastHttpStatus = 200;
                lastResponseMsg = 'OK - Weather verified';
            } catch (apiErr) {
                const status = apiErr.response ? apiErr.response.status : null;
                let errorMsg = 'Cannot activate key. Connection test failed.';
                if (status === 401) {
                    errorMsg = 'Invalid API Key';
                } else if (status === 403) {
                    errorMsg = 'API quota exceeded';
                } else if (status === 429) {
                    errorMsg = 'Rate limit exceeded';
                } else if (status && status >= 500) {
                    errorMsg = 'Provider temporarily unavailable';
                }
                return res.status(400).json({ error: errorMsg });
            }
        } else if (serviceName === 'Precious Metals API') {
            if (!apiKey) {
                return res.status(400).json({ error: `API key is required to rotate Precious Metals API.` });
            }
            const axios = require('axios');
            try {
                await axios.get(`https://www.goldapi.io/api/XAU/USD`, {
                    headers: { 'x-access-token': apiKey },
                    timeout: 6000
                });
                lastHttpStatus = 200;
                lastResponseMsg = `OK - Precious Metals verified`;
            } catch (apiErr) {
                return res.status(400).json({ error: `Invalid Precious Metals API Key: Verification failed` });
            }
        } else if (serviceName === 'Fuel API') {
            if (!apiKey) {
                return res.status(400).json({ error: 'API key is required to rotate Fuel API.' });
            }
            const axios = require('axios');
            try {
                await axios.get('https://fuel.indianapi.in/live_fuel_price?fuel_type=petrol&location_type=state', {
                    headers: { 'x-api-key': apiKey },
                    timeout: 6000
                });
                lastHttpStatus = 200;
                lastResponseMsg = 'OK - Fuel verified';
            } catch (apiErr) {
                return res.status(400).json({ error: 'Invalid Fuel API Key: Verification failed' });
            }
        }

        // 2. Encrypt the key
        const encryptedKey = apiKey ? encrypt(apiKey) : undefined;

        // 3. Retire previous active configurations
        const oldConfigs = await ExternalApiConfig.find({ serviceName, status: 'ACTIVE' });
        for (const oldConfig of oldConfigs) {
            oldConfig.status = 'RETIRED';
            oldConfig.endDate = Date.now();
            oldConfig.reason = reason || 'API Key rotated by administrator';
            oldConfig.updatedAt = Date.now();
            await oldConfig.save();
        }

        // 4. Create new ACTIVE config
        const newConfig = await ExternalApiConfig.create({
            serviceName,
            provider,
            apiKey: encryptedKey,
            status: 'ACTIVE',
            enabled: true,
            startDate: Date.now(),
            reason: reason || 'Newly activated credentials',
            lastTested: Date.now(),
            lastHttpStatus,
            lastResponseMsg,
            updatedBy: req.user.name || 'Admin',
            updatedAt: Date.now()
        });

        // 5. Update settingsService config flags to enabled so it's in sync
        const settingsUpdates = {};
        if (serviceName === 'Weather API') settingsUpdates.weatherApiEnabled = true;
        if (serviceName === 'Stock Market API') settingsUpdates.marketApiEnabled = true;
        if (serviceName === 'Precious Metals API') settingsUpdates.preciousMetalsApiEnabled = true;
        if (serviceName === 'Fuel API') settingsUpdates.fuelApiEnabled = true;
        await settingsService.updateSettings(settingsUpdates, req.user._id);

        res.json({ success: true, message: `${serviceName} rotated and activated successfully.`, config: newConfig });
    } catch (err) {
        handleError(res, err, 'Rotate External API Error');
    }
});

// Toggle API enabled/disabled status
app.patch('/api/admin/external-apis/toggle', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { serviceName, enabled } = req.body;
        if (!serviceName || enabled === undefined) {
            return res.status(400).json({ error: 'Service name and enabled status are required.' });
        }

        // Find active or create placeholder
        let config = await ExternalApiConfig.findOne({ serviceName, status: 'ACTIVE' });
        if (!config) {
            let provider = 'Custom API';
            if (serviceName === 'Weather API') provider = 'WeatherAPI';
            if (serviceName === 'Stock Market API') provider = 'Yahoo Finance';
            if (serviceName === 'Precious Metals API') provider = 'GoldAPI.io';
            if (serviceName === 'Fuel API') provider = 'm2c Fuel API';

            config = await ExternalApiConfig.create({
                serviceName,
                provider,
                status: 'ACTIVE',
                enabled: enabled,
                startDate: Date.now(),
                reason: 'Auto-initialized config on toggle',
                updatedBy: req.user.name || 'Admin',
                updatedAt: Date.now()
            });
        } else {
            config.enabled = enabled;
            config.updatedAt = Date.now();
            config.updatedBy = req.user.name || 'Admin';
            await config.save();
        }

        // Sync to SystemSettings
        const settingsUpdates = {};
        if (serviceName === 'Weather API') settingsUpdates.weatherApiEnabled = enabled;
        if (serviceName === 'Stock Market API') settingsUpdates.marketApiEnabled = enabled;
        if (serviceName === 'Precious Metals API') settingsUpdates.preciousMetalsApiEnabled = enabled;
        if (serviceName === 'Fuel API') settingsUpdates.fuelApiEnabled = enabled;
        await settingsService.updateSettings(settingsUpdates, req.user._id);

        res.json({ success: true, message: `${serviceName} has been ${enabled ? 'enabled' : 'disabled'}.`, config });
    } catch (err) {
        handleError(res, err, 'Toggle External API Error');
    }
});

// Get health/status of APIs
app.get('/api/admin/external-apis/health', verifyToken, requireAdmin, async (req, res) => {
    try {
        const weatherConfig = await ExternalApiConfig.findOne({ serviceName: 'Weather API', status: 'ACTIVE' });
        const stockConfig = await ExternalApiConfig.findOne({ serviceName: 'Stock Market API', status: 'ACTIVE' });
        const preciousMetalsConfig = await ExternalApiConfig.findOne({ serviceName: 'Precious Metals API', status: 'ACTIVE' });
        const fuelConfig = await ExternalApiConfig.findOne({ serviceName: 'Fuel API', status: 'ACTIVE' });
        
        const settings = await settingsService.getSettings();

        const isWeatherEnabled = weatherConfig ? weatherConfig.enabled : settings.weatherApiEnabled;
        const isStockEnabled = stockConfig ? stockConfig.enabled : settings.marketApiEnabled;
        const isPreciousMetalsEnabled = preciousMetalsConfig ? preciousMetalsConfig.enabled : settings.preciousMetalsApiEnabled;
        const isFuelEnabled = fuelConfig ? fuelConfig.enabled : settings.fuelApiEnabled;

        // Perform brief health check calls
        let weatherStatus = 'Disconnected';
        if (isWeatherEnabled) {
            try {
                let key = process.env.WEATHER_API_KEY || process.env.VITE_WEATHER_API_KEY || '71e7436123ba4731a9b191053261906';
                if (weatherConfig && weatherConfig.apiKey) {
                    const dec = decrypt(weatherConfig.apiKey);
                    if (dec) key = dec;
                }
                const axios = require('axios');
                await axios.get(`https://api.weatherapi.com/v1/forecast.json?key=${key}&q=London&days=1`, { timeout: 3000 });
                weatherStatus = 'Connected';
            } catch (err) {
                weatherStatus = 'Disconnected';
            }
        } else {
            weatherStatus = 'Disabled';
        }

        let stockStatus = 'Disconnected';
        if (isStockEnabled) {
            try {
                const YahooFinance = require('yahoo-finance2').default;
                const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
                await yahooFinance.quote(['AAPL']);
                stockStatus = 'Connected';
            } catch (err) {
                stockStatus = 'Disconnected';
            }
        } else {
            stockStatus = 'Disabled';
        }

        let preciousMetalsStatus = 'Disconnected';
        if (isPreciousMetalsEnabled) {
            try {
                let key = 'goldapi-e534f854ad9d063b91a413673b705ee7-io';
                if (preciousMetalsConfig && preciousMetalsConfig.apiKey) {
                    const dec = decrypt(preciousMetalsConfig.apiKey);
                    if (dec) key = dec;
                }
                const axios = require('axios');
                await axios.get('https://www.goldapi.io/api/XAU/USD', {
                    headers: { 'x-access-token': key },
                    timeout: 3000
                });
                preciousMetalsStatus = 'Connected';
            } catch (e) {
                preciousMetalsStatus = 'Disconnected';
            }
        } else {
            preciousMetalsStatus = 'Disabled';
        }

        let fuelStatus = 'Disconnected';
        if (isFuelEnabled) {
            try {
                let key = 'sk-live-kL3JzfGtjyqvUIYFxHDAHZuadiFiQjyTMt8nO0bG';
                if (fuelConfig && fuelConfig.apiKey) {
                    const dec = decrypt(fuelConfig.apiKey);
                    if (dec) key = dec;
                }
                const axios = require('axios');
                await axios.get('https://fuel.indianapi.in/live_fuel_price?fuel_type=petrol&location_type=state', {
                    headers: { 'x-api-key': key },
                    timeout: 3000
                });
                fuelStatus = 'Connected';
            } catch (e) {
                fuelStatus = 'Disconnected';
            }
        } else {
            fuelStatus = 'Disabled';
        }

        res.json({
            weatherStatus,
            stockStatus,
            preciousMetalsStatus,
            fuelStatus,
            timestamp: new Date()
        });
    } catch (err) {
        handleError(res, err, 'External APIs Health Check Error');
    }
});

// --- NOTIFICATION APIS ---
app.get('/api/notifications', verifyToken, async (req, res) => {
    try {
        const notifications = await Notification.find({ userId: req.user._id.toString() }).sort({ createdAt: -1 });
        res.json(notifications);
    } catch (err) {
        handleError(res, err, 'Fetch Notifications Error');
    }
});

app.patch('/api/notifications/:id/read', verifyToken, async (req, res) => {
    try {
        const notification = await Notification.findOneAndUpdate(
            { _id: req.params.id, userId: req.user._id.toString() },
            { isRead: true },
            { new: true }
        );
        if (!notification) {
            return res.status(404).json({ success: false, error: 'Notification not found' });
        }
        res.json(notification);
    } catch (err) {
        handleError(res, err, 'Mark Notification Read Error');
    }
});

app.post('/api/notifications/read-all', verifyToken, async (req, res) => {
    try {
        await Notification.updateMany(
            { userId: req.user._id.toString(), isRead: false },
            { isRead: true }
        );
        res.json({ success: true, message: 'All notifications marked as read' });
    } catch (err) {
        handleError(res, err, 'Mark All Notifications Read Error');
    }
});

// --- AUTHOR PERFORMANCE API ---
app.get('/api/author/performance', verifyToken, async (req, res) => {
    try {
        const authorId = req.user._id.toString();
        const { period = '7d' } = req.query;

        const now = new Date();
        let startDate;
        if (period === '30d') startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        else startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        // 1. Basic Stats
        const articles = await Article.find({ authorId }).sort({ createdAt: -1 });
        const totalArticles = articles.length;
        const totalViews = articles.reduce((sum, a) => sum + (a.views || 0), 0);
        const totalLikes = articles.reduce((sum, a) => sum + (a.likes || 0), 0);
        const totalShares = articles.reduce((sum, a) => sum + (a.shares || 0), 0);
        const averageViews = totalArticles > 0 ? totalViews / totalArticles : 0;

        // 2. Top Articles
        const topArticles = [...articles]
            .sort((a, b) => (b.views || 0) - (a.views || 0))
            .slice(0, 5)
            .map(a => ({ title: a.title, views: a.views || 0, category: a.category, likes: a.likes || 0 }));

        const mostViewedArticle = topArticles[0] || null;

        // 3. Performance Trend (Aggregating from logs)
        const AnalyticsLogV1 = require('./models/AnalyticsLogV1');
        const growthChart = await AnalyticsLogV1.aggregate([
            { $match: { 
                articleId: { $in: articles.map(a => a._id) },
                timestamp: { $gte: startDate },
                type: 'PAGE_VIEW'
            }},
            { $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
                views: { $sum: 1 }
            }},
            { $sort: { _id: 1 } },
            { $project: { date: "$_id", views: 1, _id: 0 } }
        ]);

        res.json({
            totalArticles,
            totalViews,
            totalLikes,
            totalShares,
            averageViews,
            mostViewedArticle,
            topArticles,
            recentArticles: articles.slice(0, 5).map(a => ({ title: a.title, views: a.views || 0, category: a.category, createdAt: a.createdAt })),
            growthChart
        });
    } catch (err) {
        handleError(res, err, 'Author Performance Error');
    }
});

// --- RECRUITMENT APIs ---
// GET /api/recruitment - Get recruitment settings for admin
app.get('/api/recruitment', verifyToken, requireAdmin, async (req, res) => {
    try {
        const Recruitment = require('./models/Recruitment');
        let recruitment = await Recruitment.findOne();
        if (!recruitment) {
            // Seed a default one if none exists
            recruitment = new Recruitment({
                title: 'Join the NewsPercent Team',
                description: 'We\'re always looking for passionate journalists, designers, developers and creators who want to shape the future of digital journalism.',
                googleFormLink: 'https://forms.google.com',
                buttonText: 'Apply Now',
                status: 'OPEN',
                published: 'Published'
            });
            await recruitment.save();
        }
        res.json({ success: true, data: recruitment });
    } catch (err) {
        handleError(res, err, 'Get Recruitment Settings Error');
    }
});

// PUT /api/recruitment - Update recruitment settings (Admin only)
app.put('/api/recruitment', verifyToken, requireAdmin, async (req, res) => {
    try {
        const Recruitment = require('./models/Recruitment');
        const { title, description, googleFormLink, buttonText, status, published } = req.body;
        
        let recruitment = await Recruitment.findOne();
        if (recruitment) {
            recruitment.title = title || recruitment.title;
            recruitment.description = description !== undefined ? description : recruitment.description;
            recruitment.googleFormLink = googleFormLink || recruitment.googleFormLink;
            recruitment.buttonText = buttonText || recruitment.buttonText;
            recruitment.status = status || recruitment.status;
            recruitment.published = published || recruitment.published;
            await recruitment.save();
        } else {
            recruitment = new Recruitment({
                title,
                description,
                googleFormLink,
                buttonText,
                status,
                published
            });
            await recruitment.save();
        }
        res.json({ success: true, data: recruitment });
    } catch (err) {
        handleError(res, err, 'Update Recruitment Settings Error');
    }
});

// GET /api/public/recruitment - Get published recruitment settings for public Careers page
app.get('/api/public/recruitment', async (req, res) => {
    try {
        const Recruitment = require('./models/Recruitment');
        const recruitment = await Recruitment.findOne();
        
        // If not exists or is draft, return status as CLOSED
        if (!recruitment || recruitment.published === 'Draft') {
            return res.json({ 
                success: true, 
                data: { 
                    status: 'CLOSED', 
                    title: 'Join the NewsPercent Team',
                    description: '',
                    googleFormLink: '',
                    buttonText: 'Apply Now',
                    published: 'Draft'
                } 
            });
        }
        
        res.json({ success: true, data: recruitment });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message, status: 'CLOSED' });
    }
});

// --- FLASH NEWS API ---
app.get('/api/flash', async (req, res) => {
    try {
        const flash = await FlashNews.find({ active: true })
            .sort({ createdAt: -1 })
            .limit(20);
        res.json(flash);
    } catch (err) {
        handleError(res, err, 'Fetch Flash News Error');
    }
});

app.get('/api/admin/flash', verifyToken, requireAdmin, async (req, res) => {
    try {
        const flash = await FlashNews.find().sort({ createdAt: -1 });
        res.json(flash);
    } catch (err) {
        handleError(res, err, 'Admin Fetch Flash Error');
    }
});

app.post('/api/admin/flash', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { headline } = req.body;
        const newFlash = await FlashNews.create({ headline, active: true });
        res.status(201).json(newFlash);
    } catch (err) {
        handleError(res, err, 'Create Flash News Error');
    }
});

app.patch('/api/admin/flash/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
        const flash = await FlashNews.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(flash);
    } catch (err) {
        handleError(res, err, 'Update Flash News Error');
    }
});

app.delete('/api/admin/flash/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
        await FlashNews.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        handleError(res, err, 'Delete Flash News Error');
    }
});

// --- STORAGE CONFIGURATION ENDPOINTS ---

app.get('/api/admin/storage/config', verifyToken, requireAdmin, async (req, res) => {
    try {
        const articleConfig = await StorageConfig.findOne({ purpose: { $in: ['Article Content Images', 'article'] }, status: 'ACTIVE' }).sort({ startDate: -1 });
        const profileConfig = await StorageConfig.findOne({ purpose: { $in: ['Profile Images', 'profile'] }, status: 'ACTIVE' }).sort({ startDate: -1 });
        
        const allConnections = await StorageConfig.find().sort({ startDate: -1 });

        const currentActive = articleConfig ? {
            cloudName: articleConfig.cloudName,
            apiKey: articleConfig.apiKey,
            status: articleConfig.status,
            updatedAt: articleConfig.updatedAt,
            updatedBy: articleConfig.updatedBy,
            folderPrefix: articleConfig.folderPrefix,
            purpose: articleConfig.purpose,
            startDate: articleConfig.startDate
        } : {
            cloudName: process.env.ARTICLE_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME || 'Default (.env)',
            apiKey: process.env.ARTICLE_API_KEY || process.env.CLOUDINARY_API_KEY || 'N/A',
            status: 'ACTIVE',
            updatedAt: null,
            updatedBy: 'System Default (.env)',
            folderPrefix: 'newspercent',
            purpose: 'Article Content Images',
            startDate: new Date('2026-06-01')
        };

        const profileActive = profileConfig ? {
            cloudName: profileConfig.cloudName,
            apiKey: profileConfig.apiKey,
            status: profileConfig.status,
            updatedAt: profileConfig.updatedAt,
            updatedBy: profileConfig.updatedBy,
            folderPrefix: profileConfig.folderPrefix,
            purpose: profileConfig.purpose,
            startDate: profileConfig.startDate
        } : {
            cloudName: process.env.PROFILE_CLOUDINARY_CLOUD_NAME || process.env.PROFILE_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME || 'Default (.env)',
            apiKey: process.env.PROFILE_CLOUDINARY_API_KEY || process.env.PROFILE_API_KEY || process.env.CLOUDINARY_API_KEY || 'N/A',
            status: 'ACTIVE',
            updatedAt: null,
            updatedBy: 'System Default (.env)',
            folderPrefix: 'newspercent/profiles',
            purpose: 'Profile Images',
            startDate: new Date('2026-06-01')
        };

        res.json({
            currentActive,
            profileActive,
            allConnections,
            history: allConnections
        });
    } catch (err) {
        handleError(res, err, 'Fetch Storage Config Error');
    }
});

app.post('/api/admin/storage/verify', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { cloudName, apiKey, apiSecret, folderPrefix, purpose } = req.body;
        if (!cloudName || !apiKey || !apiSecret || !purpose) {
            return res.status(400).json({ error: 'Missing required credentials or purpose' });
        }

        const testImageBuffer = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        const testUpload = () => {
            return new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    {
                        cloud_name: cloudName,
                        api_key: apiKey,
                        api_secret: apiSecret,
                        folder: folderPrefix || 'newspercent/test-connection',
                        resource_type: 'auto'
                    },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                stream.end(testImageBuffer);
            });
        };

        console.log('--- STORAGE VERIFICATION LOG ---');
        console.log('Purpose:', purpose);
        console.log('Testing Cloud Name:', cloudName);
        await testUpload();
        console.log('Verification successful.');
        res.json({ success: true, message: 'Connection verified successfully' });
    } catch (err) {
        console.error('Validation test upload failed:', err);
        res.status(400).json({ error: err.message || 'Validation failed' });
    }
});

app.post('/api/admin/storage/config', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { cloudName, apiKey, apiSecret, folderPrefix, purpose, reason } = req.body;
        if (!cloudName || !apiKey || !apiSecret || !purpose) {
            return res.status(400).json({ error: 'Missing required credentials or purpose' });
        }

        if (!['Profile Images', 'Article Content Images', 'profile', 'article'].includes(purpose)) {
            return res.status(400).json({ error: 'Invalid purpose selected' });
        }

        const testImageBuffer = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        const testUpload = () => {
            return new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    {
                        cloud_name: cloudName,
                        api_key: apiKey,
                        api_secret: apiSecret,
                        folder: folderPrefix || 'newspercent/test-connection',
                        resource_type: 'auto'
                    },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                stream.end(testImageBuffer);
            });
        };

        console.log('--- STORAGE CONFIG SAVE LOG ---');
        console.log('Saving and activating new storage connection');
        console.log('Purpose:', purpose);
        console.log('Cloud Name:', cloudName);
        
        await testUpload();

        const encryptedSecret = encrypt(apiSecret);

        // Find existing active config for this purpose and retire them
        const matchedPurposes = ['profile', 'Profile Images'].includes(purpose)
            ? ['profile', 'Profile Images']
            : ['article', 'Article Content Images'];
        const oldConfigs = await StorageConfig.find({ purpose: { $in: matchedPurposes }, status: 'ACTIVE' });
        for (const oldConfig of oldConfigs) {
            oldConfig.status = 'RETIRED';
            oldConfig.endDate = Date.now();
            oldConfig.reason = reason || 'Storage rotated by administrator';
            oldConfig.updatedAt = Date.now();
            await oldConfig.save();
            console.log(`[STORAGE ROTATION] Retired previous active storage for purpose "${purpose}": ${oldConfig.cloudName}`);
        }

        // Create new active config
        const newConfig = await StorageConfig.create({
            cloudName,
            apiKey,
            apiSecret: encryptedSecret,
            folderPrefix: folderPrefix || 'newspercent',
            purpose,
            status: 'ACTIVE',
            startDate: Date.now(),
            updatedBy: req.user.name || 'Admin',
            updatedAt: Date.now()
        });

        // Also write to audit history table
        await StorageHistory.create({
            date: Date.now(),
            adminName: req.user.name || 'Admin',
            oldCloudName: oldConfigs.length > 0 ? oldConfigs[0].cloudName : 'Default (.env)',
            newCloudName: cloudName,
            reason: `${purpose} rotation: ${reason || 'Credentials updated'}`
        });

        console.log(`[STORAGE ROTATION] Activated new storage for purpose "${purpose}": ${cloudName}`);
        res.json({ success: true, message: `New ${purpose} storage activated successfully.` });
    } catch (err) {
        console.error('Failed to update storage configuration:', err);
        res.status(400).json({ error: err.message || 'Validation failed. Configuration not saved.' });
    }
});

// --- MONGODB CONNECTION API ---

app.get('/api/admin/database/status', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { getRegisteredClustersList } = require('./config/database');
        const clusters = await getRegisteredClustersList();
        const activeCluster = clusters.find(c => c.isActive) || clusters[0];
        
        res.json({
            success: true,
            activeCluster,
            registeredClusters: clusters
        });
    } catch (err) {
        console.error('Fetch database status failed:', err);
        res.status(500).json({ error: err.message || 'Failed to fetch database status' });
    }
});

app.post('/api/admin/database/test', verifyToken, requireAdmin, async (req, res) => {
    const { uri } = req.body;
    try {
        const { testClusterConnection } = require('./config/database');
        const result = await testClusterConnection(uri);
        res.json(result);
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/database/register', verifyToken, requireAdmin, async (req, res) => {
    const { uri, notes } = req.body;
    try {
        const { registerNewCluster } = require('./config/database');
        const result = await registerNewCluster(uri, notes);
        res.json(result);
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/database/activate', verifyToken, requireAdmin, async (req, res) => {
    const { clusterId } = req.body;
    try {
        const { makeClusterActive } = require('./config/database');
        const result = await makeClusterActive(clusterId);
        res.json(result);
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/database/remove', verifyToken, requireAdmin, async (req, res) => {
    const { clusterId } = req.body;
    try {
        const { removeCluster } = require('./config/database');
        const ActivityLog = require('./models/ActivityLog');
        
        const result = await removeCluster(clusterId);
        
        // Audit log
        await ActivityLog.create({
            userId: req.user._id,
            userName: req.user.name,
            action: 'DATABASE_CLUSTER_REMOVAL',
            ipAddress: req.ip || req.connection.remoteAddress,
            userAgent: req.headers['user-agent'],
            details: {
                adminName: req.user.name || 'Admin',
                action: 'Removed Cluster',
                clusterName: result.clusterName,
                date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
            }
        });

        res.json(result);
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Helper to resolve build dist directory across Hostinger / PM2 environment structures
// Helper to resolve build dist directory across Hostinger / PM2 environment structures
const getDistPath = () => {
    const fs = require('fs');
    const path = require('path');
    const candidates = [
        path.join(__dirname, 'newspercent', 'dist'),
        path.join(__dirname, 'dist'),
        path.join(process.cwd(), 'newspercent', 'dist'),
        path.join(process.cwd(), 'dist')
    ];
    return candidates.find(p => fs.existsSync(path.join(p, 'index.html'))) || candidates[0];
};

const getActiveIndexPath = () => {
    const fs = require('fs');
    const path = require('path');
    const candidates = [
        path.join(__dirname, 'newspercent', 'dist'),
        path.join(__dirname, 'dist'),
        path.join(process.cwd(), 'newspercent', 'dist'),
        path.join(process.cwd(), 'dist')
    ];
    const found = candidates.find(p => fs.existsSync(path.join(p, 'index.html')));
    return found ? path.join(found, 'index.html') : path.join(candidates[0], 'index.html');
};

// Serve static assets from all candidate build directories to avoid race conditions
app.use(express.static(path.join(__dirname, 'newspercent', 'dist')));
app.use(express.static(path.join(__dirname, 'dist')));
app.use(express.static(path.join(process.cwd(), 'newspercent', 'dist')));
app.use(express.static(path.join(process.cwd(), 'dist')));

// Serve article views with server-side SEO meta injection
app.get('/article/:slugOrId', async (req, res, next) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const Article = require('./models/Article');
        
        const slugOrId = req.params.slugOrId;
        
        // Find article by slug or ID
        let article;
        if (mongoose.Types.ObjectId.isValid(slugOrId)) {
            article = await Article.findById(slugOrId);
        }
        if (!article) {
            article = await Article.findOne({ slug: slugOrId });
        }
        
        if (!article || article.status !== 'PUBLISHED') {
            return next(); // Article not found or not published -> Pass to SPA fallback
        }

        const indexPath = getActiveIndexPath();
        if (!fs.existsSync(indexPath)) {
            return next(); // Fallback to SPA routing
        }
        
        let html = fs.readFileSync(indexPath, 'utf8');
        
        const title = article.seoTitle || `${article.title} | NewsPercent`;
        const description = article.metaDescription || article.subtitle || '';
        const keywords = article.keywords && article.keywords.length > 0 ? article.keywords.join(', ') : (article.category || '');
        const currentHost = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
        const canonical = article.canonicalUrl || `${currentHost}/article/${article.slug || article._id}`;
        const robots = article.robotsDirective || 'index, follow';
        const ogImage = article.openGraphImage || article.featuredImage || '';
        
        // Generate structured JSON-LD data
        const schema = article.schemaMarkup || {
            "@context": "https://schema.org",
            "@type": "NewsArticle",
            "headline": article.title,
            "image": [article.featuredImage || ''],
            "datePublished": article.publishedAt || article.createdAt,
            "dateModified": article.updatedAt || article.createdAt,
            "description": description,
            "mainEntityOfPage": {
                "@type": "WebPage",
                "@id": canonical
            }
        };
        const jsonLdString = JSON.stringify(schema);
        
        // Construct target meta tags to inject in the HTML head
        const metaTags = `
    <title>${title}</title>
    <meta name="description" content="${description.replace(/"/g, '&quot;')}" />
    <meta name="keywords" content="${keywords.replace(/"/g, '&quot;')}" />
    <meta name="robots" content="${robots}" />
    <link rel="canonical" href="${canonical}" />
    
    <!-- Open Graph / Facebook / LinkedIn / WhatsApp -->
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${title.replace(/"/g, '&quot;')}" />
    <meta property="og:description" content="${description.replace(/"/g, '&quot;')}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:site_name" content="NewsPercent" />
    
    <!-- Twitter / X -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title.replace(/"/g, '&quot;')}" />
    <meta name="twitter:description" content="${description.replace(/"/g, '&quot;')}" />
    <meta name="twitter:image" content="${ogImage}" />
    
    <!-- Structured Data (JSON-LD) -->
    <script type="application/ld+json">
        ${jsonLdString}
    </script>
        `;
        
        // Replace default placeholder title and meta tags with injected tags
        html = html.replace(/<title>.*?<\/title>/i, ''); // Remove default title tag if exists
        html = html.replace('<head>', `<head>${metaTags}`);
        
        res.send(html);
    } catch (err) {
        console.error('[SEO INJECTION ERROR]:', err);
        return next();
    }
});

// Serve category views (fallback to SPA index.html)
app.get('/category/:slug', (req, res, next) => {
    const fs = require('fs');
    const indexPath = getActiveIndexPath();
    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    }
    return next();
});

// SPA fallback route for React frontend routes (excludes /api/*)
app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) {
        return next();
    }
    const fs = require('fs');
    const indexPath = getActiveIndexPath();
    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    }
    return res.status(500).json({
        success: false,
        error: 'Frontend build not found (index.html missing). Please run npm run build.'
    });
});

// --- GLOBAL ERROR & 404 HANDLER MIDDLEWARE ---
// 404 Handler for API route failures
app.use((req, res, next) => {
    const err = new Error(`API Route not found: ${req.method} ${req.originalUrl}`);
    err.status = 404;
    next(err);
});

// Global Error Handler
// Global Error Handler
app.use((err, req, res, next) => {
    const statusCode = err.status || 500;
    
    // Log exception using our production logger
    logError(err, req, `BACKEND EXCEPTION: ${req.method} ${req.originalUrl}`);

    const isMongoError = err.name === 'MongoError' || 
                         err.name === 'ValidationError' || 
                         err.name === 'MongooseError' ||
                         err.message.toLowerCase().includes('mongo') || 
                         err.message.toLowerCase().includes('mongoose') ||
                         err.message.toLowerCase().includes('connection') ||
                         err.message.toLowerCase().includes('topology');

    // In production, mask detailed 500 error messages to prevent leakage
    const showRawMessage = process.env.NODE_ENV !== 'production' || statusCode < 500;
    const responseError = showRawMessage ? (err.message || 'Internal Server Error') : 'Internal Server Error';

    const errResponse = {
        success: false,
        error: responseError,
        route: req.originalUrl,
        statusCode: statusCode,
        databaseState: mongoose.connection.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED',
        isMongoError,
        timestamp: new Date().toISOString()
    };

    if (process.env.NODE_ENV !== 'production') {
        errResponse.stack = err.stack;
    }

    res.status(statusCode).json(errResponse);
});

// --- STARTUP SEQUENCE ---
const startServer = async () => {
    const startupSteps = {
        environmentValidation: 'PENDING',
        databaseConnection: 'PENDING',
        systemSettings: 'PENDING',
        superAdminInit: 'PENDING',
        analyticsArchival: 'PENDING',
        expressListen: 'PENDING'
    };

    console.log('=================================');
    console.log('🔄 Initializing System Startup...');

    // 1. Validate Environment Variables
    try {
        const requiredEnvVars = ['MONGODB_URI', 'JWT_SECRET'];
        const missingVars = requiredEnvVars.filter(v => !process.env[v]);
        
        if (missingVars.length > 0) {
            console.warn(`⚠️ [Startup Logger] WARNING: Missing environment variables: ${missingVars.join(', ')}`);
            if (process.env.NODE_ENV === 'production') {
                console.error(`❌ [Startup Logger] CRITICAL: Missing critical environment variables in production!`);
                startupSteps.environmentValidation = 'FAILED';
            } else {
                startupSteps.environmentValidation = 'WARNING';
            }
        } else {
            startupSteps.environmentValidation = 'SUCCESS';
        }
    } catch (err) {
        startupSteps.environmentValidation = 'FAILED';
        console.error('❌ [Startup Logger] Environment validation threw an error:', err.message);
    }

    // 2. Connect to Database
    try {
        console.log('[SYS] Connecting to database...');
        await connectDB();
        startupSteps.databaseConnection = 'SUCCESS';
    } catch (err) {
        startupSteps.databaseConnection = 'FAILED';
        console.error('❌ [Startup Logger] Database connection failed:', err.message);
    }

    // 3. Load system settings
    if (startupSteps.databaseConnection === 'SUCCESS') {
        try {
            console.log('[SYS] Loading system settings...');
            await settingsService.getSettings();
            startupSteps.systemSettings = 'SUCCESS';
        } catch (err) {
            startupSteps.systemSettings = 'FAILED';
            console.error('❌ [Startup Logger] Loading system settings failed:', err.message);
        }
    } else {
        startupSteps.systemSettings = 'SKIPPED';
    }

    // 4. Initialize Super Admin
    if (startupSteps.databaseConnection === 'SUCCESS') {
        try {
            console.log('[SYS] Initializing Super Admin...');
            await initializeSuperAdmin();
            startupSteps.superAdminInit = 'SUCCESS';
        } catch (err) {
            startupSteps.superAdminInit = 'FAILED';
            console.error('❌ [Startup Logger] Super Admin initialization failed:', err.message);
        }
    } else {
        startupSteps.superAdminInit = 'SKIPPED';
    }

    // 5. Analytics Archival Check
    if (startupSteps.databaseConnection === 'SUCCESS') {
        try {
            console.log('[SYS] Checking for analytics archival...');
            const analyticsService = require('./services/analyticsService');
            await analyticsService.archiveMonthlyData();
            startupSteps.analyticsArchival = 'SUCCESS';
        } catch (err) {
            startupSteps.analyticsArchival = 'FAILED';
            console.error('❌ [Startup Logger] Analytics archival check failed:', err.message);
        }
    } else {
        startupSteps.analyticsArchival = 'SKIPPED';
    }

    // 6. Start Express Server
    try {
        console.log(`[SYS] Starting Express server on port ${PORT}...`);
        app.listen(PORT, () => {
            startupSteps.expressListen = 'SUCCESS';
            const fs = require('fs');
            const path = require('path');
            const hasDist = fs.existsSync(path.join(__dirname, 'newspercent', 'dist', 'index.html'));
            const isDev = process.env.NODE_ENV !== 'production';
            const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;

            console.log('=================================');
            console.log('🚀 NewsPercent Backend Started');
            console.log('=================================');
            console.log(`🌐 Backend URL: ${appUrl}`);
            if (hasDist) {
                console.log(`📰 Frontend (served by Express): ${appUrl}`);
            }
            console.log(`⚙️ API Base URL: ${appUrl}/api`);
            console.log(`❤️ Health Check: ${appUrl}/api/health`);
            console.log(`📁 MongoDB State: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'}`);
            console.log(`📧 Email Service: ${process.env.EMAIL_USER && process.env.EMAIL_PASS ? 'Active' : 'Missing Credentials'}`);
            console.log(`🔐 JWT Status: ${process.env.JWT_SECRET ? 'Configured' : 'Using Fallback Secret (Unsafe)'}`);
            console.log('=================================');
            console.log('[Startup Logger] Startup sequence status:');
            console.log(JSON.stringify(startupSteps, null, 2));
            console.log('=================================');
        });
    } catch (err) {
        startupSteps.expressListen = 'FAILED';
        console.error('❌ [Startup Logger] CRITICAL: Express server failed to start:', err.message);
        console.log('=================================');
        console.log('[Startup Logger] Final startup status before exit:');
        console.log(JSON.stringify(startupSteps, null, 2));
        console.log('=================================');
        process.exit(1);
    }
};

startServer();
