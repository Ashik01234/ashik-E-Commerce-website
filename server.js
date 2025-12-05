const express = require("express");
const bodyParser = require("body-parser");
const mysql = require("mysql2");
const session = require("express-session");
const MySQLStore = require("express-mysql-session")(session);
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcrypt");

// Razorpay setup
const Razorpay = require("razorpay");
const razorpay = new Razorpay({
    key_id: "rzp_test_RIo4sYyENAZOrE",
    key_secret: "P8EAdTqUDljOvMDHv5Zfwd7D"
});
const app = express();

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static("public"));
app.use("/public", express.static(path.join(__dirname, "public")));

// EJS setup
app.set("view engine", "ejs");
app.set("views", "views");

// MySQL connection
const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "",
    database: "shopping_cart"
});

db.connect((err) => {
    if (err) {
        console.error("❌ Error connecting to MySQL:", err);
        process.exit(1);
    }
    console.log("✅ MySQL Database connected successfully");
});

// Session store
app.use(session({
    secret: "1234567890",
    resave: false,
    saveUninitialized: true,
    store: new MySQLStore({
        host: "localhost",
        user: "root",
        password: "",
        database: "shopping_cart"
    })
}));

// Middleware to protect user routes
function requireUser(req, res, next) {
    if (req.session.userId) return next();
    res.redirect("/login");
}

// Admin routes
const adminRoutes = require("./routes/admin");
app.use("/admin", adminRoutes);

//Payment routes
const paymentRoutes = require("./routes/payment");
app.use("/", paymentRoutes);

//  Checkout route here
app.get("/checkout", requireUser, (req, res) => {
    const user_id = req.session.userId;

    const cartSql = `
        SELECT p.product_id, p.product_name, p.product_price, ci.quantity
        FROM cart_items ci
        JOIN product p ON ci.product_id = p.product_id
        WHERE ci.user_id = ?
    `;
    db.query(cartSql, [user_id], (err, cartItems) => {
        if (err) throw err;

        res.render("checkout", {
            cart: cartItems,
            email: req.session.email
        });
    });
});

//  My Orders route 
app.get("/my-orders", requireUser, (req, res) => {
    const user_id = req.session.userId;

    const sql = `
        SELECT 
            o.user_order_number,
            o.created_at AS order_date,
            o.customer_name,
            o.customer_address,
            o.payment_method,
            o.total_amount,
            o.payment_status AS status,
            p.product_name,
            p.product_image,
            oi.quantity,
            oi.price
        FROM orders o
        JOIN order_items oi ON o.order_id = oi.order_id
        JOIN product p ON oi.product_id = p.product_id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC
    `;

    db.query(sql, [user_id], (err, results) => {
        if (err) {
            console.error("Error fetching orders:", err);
            return res.status(500).send("Error fetching orders");
        }

        const ordersMap = {};

        results.forEach(row => {
            if (!ordersMap[row.user_order_number]) {
                ordersMap[row.user_order_number] = {
                    user_order_number: row.user_order_number,
                    order_date: row.order_date,
                    customer_name: row.customer_name,
                    customer_address: row.customer_address,
                    payment_method: row.payment_method,
                    total_amount: Number(row.total_amount), //  ensure numeric
                    status: row.status,
                    products: []
                };
            }

            ordersMap[row.user_order_number].products.push({
                name: row.product_name,
                image: row.product_image,
                quantity: Number(row.quantity),
                price: Number(row.price), //  ensure numeric
                line_total: Number(row.price) * Number(row.quantity) //  pre-calculated
            });
        });

        const orders = Object.values(ordersMap);
        res.render("orders_with_items", { orders });
    });
});



// Sanity check
["product"].forEach(table => {
    db.query(`SHOW TABLES LIKE ?`, [table], (err, results) => {
        if (err) console.error(err);
        else if (!results.length) console.warn(`⚠️ Missing table: ${table}`);
        else console.log(` Table OK: ${table}`);
    });
});

// Multer setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "public"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// Product upload
app.get("/upload", (req, res) => {
    res.render("upload");
});
app.post("/upload", upload.single("product_image"), (req, res) => {
    const { product_name, product_price } = req.body;
    const imagePath = req.file ? req.file.filename : null;

    const sql = `
        INSERT INTO product (product_name, product_price, product_image)
        VALUES (?, ?, ?)
    `;
    db.query(sql, [product_name, product_price, imagePath], (err) => {
        if (err) throw err;
        res.redirect("/");
    });
});


// Homepage
app.get("/", (req, res) => {
    const query = "SELECT * FROM product ORDER BY product_id DESC";
    db.query(query, (err, products) => {
        if (err) throw err;

        if (!req.session.userId) {
            return res.render("product", {
                products,
                cart: [],
                email: null
            });
        }

        const cartSql = `
            SELECT p.product_id, p.product_name, p.product_price, ci.quantity
            FROM cart_items ci
            JOIN product p ON ci.product_id = p.product_id
            WHERE ci.user_id = ?
        `;
        db.query(cartSql, [req.session.userId], (err2, cartItems) => {
            if (err2) throw err2;

            res.render("product", {
                products,
                cart: cartItems,
                email: req.session.email
            });
        });
    });
});

// Add to cart
app.post("/add_cart", requireUser, (req, res) => {
    const { product_id } = req.body;
    const user_id = req.session.userId;

    const checkSql = `
        SELECT * FROM cart_items WHERE user_id = ? AND product_id = ?
    `;
    db.query(checkSql, [user_id, product_id], (err, results) => {
        if (err) throw err;

        if (results.length > 0) {
            const updateSql = `
                UPDATE cart_items SET quantity = quantity + 1
                WHERE user_id = ? AND product_id = ?
            `;
            db.query(updateSql, [user_id, product_id], () => {
                res.redirect("/");
            });
        } else {
            const insertSql = `
                INSERT INTO cart_items (user_id, product_id, quantity)
                VALUES (?, ?, 1)
            `;
            db.query(insertSql, [user_id, product_id], () => {
                res.redirect("/");
            });
        }
    });
});

// Remove from cart
app.get("/remove_item", requireUser, (req, res) => {
    const product_id = req.query.id;
    const user_id = req.session.userId;

    const sql = `DELETE FROM cart_items WHERE user_id = ? AND product_id = ?`;
    db.query(sql, [user_id, product_id], () => {
        res.redirect("/");
    });
});

// View cart (debug)
app.get("/cart", requireUser, (req, res) => {
    const user_id = req.session.userId;
    const cartSql = `
        SELECT p.product_id, p.product_name, p.product_price, ci.quantity
        FROM cart_items ci
        JOIN product p ON ci.product_id = p.product_id
        WHERE ci.user_id = ?
    `;
    db.query(cartSql, [user_id], (err, cartItems) => {
        if (err) throw err;
        res.json(cartItems);
    });
});

// Checkout
app.get("/checkout", requireUser, (req, res) => {
    const user_id = req.session.userId;

    const cartSql = `
        SELECT p.product_id, p.product_name, p.product_price, ci.quantity
        FROM cart_items ci
        JOIN product p ON ci.product_id = p.product_id
        WHERE ci.user_id = ?
    `;
    db.query(cartSql, [user_id], (err, cartItems) => {
        if (err) throw err;

        res.render("checkout", {
            cart: cartItems,
            email: req.session.email
        });
    });
});

// place order
app.post("/place_order", requireUser, (req, res) => {
    const { customer_name, customer_address, payment_method } = req.body;
    const user_id = req.session.userId;
    const email = req.session.email;

    const cartSql = `
        SELECT p.product_id, p.product_price, ci.quantity
        FROM cart_items ci
        JOIN product p ON ci.product_id = p.product_id
        WHERE ci.user_id = ?
    `;
    db.query(cartSql, [user_id], (err, cart) => {
        if (err) throw err;
        if (cart.length === 0) return res.send("Cart is empty.");

        const countSql = `SELECT COUNT(*) AS count FROM orders WHERE user_id = ?`;
        db.query(countSql, [user_id], async (err2, result) => {
            if (err2) throw err2;

            const nextNumber = result[0].count + 1;
            const paddedNumber = String(nextNumber).padStart(4, "0");
            const year = new Date().getFullYear();
            const user_order_number = `ORD-${year}-${paddedNumber}`;

            const total_amount = cart.reduce((sum, item) => {
                return sum + item.product_price * item.quantity;
            }, 0);

            const orderSql = `
                INSERT INTO orders (customer_name, customer_address, payment_method, user_id, user_order_number, payment_status, email, total_amount)
                VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?)
            `;
            db.query(orderSql, [
                customer_name,
                customer_address,
                payment_method,
                user_id,
                user_order_number,
                email,
                total_amount
            ], async (err3, result) => {
                if (err3) throw err3;

                const order_id = result.insertId;

                //  Insert order items for ALL payment methods
                const itemsSql = `
                    INSERT INTO order_items (order_id, product_id, quantity, price)
                    SELECT ?, ci.product_id, ci.quantity, p.product_price
                    FROM cart_items ci
                    JOIN product p ON ci.product_id = p.product_id
                    WHERE ci.user_id = ?
                `;
                db.query(itemsSql, [order_id, user_id], async (err4) => {
                    if (err4) throw err4;

                    if (payment_method === "Online") {
                        // Razorpay flow
                        const options = {
                            amount: total_amount * 100,
                            currency: "INR",
                            receipt: user_order_number
                        };
                        try {
                            const razorpayOrder = await razorpay.orders.create(options);
                            return res.render("razorpay_checkout", {
                                order_id: razorpayOrder.id,
                                amount: total_amount,
                                customer_name,
                                customer_address,
                                user_order_number,
                                user_id
                            });
                        } catch (err5) {
                            console.error("Razorpay error:", err5);
                            return res.send("Payment initialization failed");
                        }
                    } else {
                        // COD or Card → clear cart immediately
                        db.query(`DELETE FROM cart_items WHERE user_id = ?`, [user_id], (err6) => {
                            if (err6) throw err6;

                            res.send(`
                                <div style="text-align:center; font-family:sans-serif; margin-top:40px;">
                                    <h2>✅ Order Placed Successfully!</h2>
                                    <p>Thank you, ${customer_name}. Your order number is <strong>${user_order_number}</strong>.</p>
                                    <a href="/" class="btn btn-primary">Continue Shopping</a>
                                    <a href="/my-orders" class="btn btn-warning">View Orders</a>
                                </div>
                            `);
                        });
                    }
                });
            });
        });
    });
});





// Orders view
app.get("/orders", requireUser, (req, res) => {
    const user_id = req.session.userId;

const sql = `
    SELECT 
        o.payment_status,
        o.created_at AS order_date,
        o.order_id,
        o.payment_method,
        o.total_amount,
        o.user_id,
        o.user_order_number,
        (
            SELECT SUM(oi.quantity * oi.price)
            FROM order_items oi
            WHERE oi.order_id = o.order_id
        ) AS calculated_total
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.order_id
    JOIN product p ON p.product_id = oi.product_id
    WHERE o.user_id = ?
    GROUP BY o.order_id
    ORDER BY o.created_at DESC
`;


    db.query(sql, [user_id], (err, orders) => {
        if (err) throw err;
        res.render("orders", { orders });
    });
});


//  User sign-up
app.get("/signup", (req, res) => {
    res.render("signup");
});

app.post("/signup", (req, res) => {
    const { email, password } = req.body;

    bcrypt.hash(password, 10, (err, hashedPassword) => {
        if (err) throw err;

        const sql = `INSERT INTO users (email, password) VALUES (?, ?)`;
        db.query(sql, [email, hashedPassword], (err2) => {
            if (err2) {
                if (err2.code === "ER_DUP_ENTRY") {
                    return res.send("Email already registered.");
                }
                throw err2;
            }
            res.redirect("/login");
        });
    });
});

//  User login
app.get("/login", (req, res) => {
    res.render("login");
});

app.post("/login", (req, res) => {
    const { email, password } = req.body;

    const sql = `SELECT * FROM users WHERE email = ?`;
    db.query(sql, [email], (err, results) => {
        if (err) throw err;
        if (results.length === 0) return res.send("Invalid email");

        const user = results[0];

        bcrypt.compare(password, user.password, (err2, match) => {
            if (match) {
                req.session.userId = user.user_id;
                req.session.email = user.email;
                res.redirect("/");
            } else {
                res.send("Incorrect password");
            }
        });
    });
});

//  Logout
app.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/login");
    });
});

//  Start server
app.listen(3000, () => {
    console.log("🚀 Server started on http://localhost:3000");
});