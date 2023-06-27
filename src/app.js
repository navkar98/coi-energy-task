const express = require('express');
const bodyParser = require('body-parser');
const { Op } = require("sequelize");
const { sequelize } = require('./model')
const { getProfile } = require('./middleware/getProfile')
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)

/**
 * FIX ME!
 * @returns contract by id
 */
app.get('/contracts/:id', getProfile, async (req, res) => {
    const { Contract, Profile } = req.app.get('models')
    const { id } = req.params

    const contract = await Contract.findOne({
        where:
        {
            id,
        },
        // Left joining the profile table two times for ContractorId and ClientId
        include: [{
            model: Profile,
            as: 'Client',
            where: { id: req.profile.id },
            required: false,
            attributes: []
        }, {
            model: Profile,
            as: 'Contractor',
            where: { id: req.profile.id },
            required: false,
            attributes: []
        }]
    });

    if (!contract) return res.status(404).end()

    // Check if the contract belongs to the profile calling the API
    if (contract.ClientId !== req.profile.id && contract.ContractorId !== req.profile.id) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    res.json(contract)
})

// GET /contracts
app.get('/contracts', getProfile, async (req, res, next) => {
    try {
        const { Contract, Profile } = req.app.get('models')

        const contracts = await Contract.findAll({
            where: {
                [Op.or]: [{ ClientId: req.profile.id }, { ContractorId: req.profile.id }],
                status: { [Op.ne]: 'terminated' },
            },
            // Left joining the profile table two times for ContractorId and ClientId
            include: [{
                model: Profile,
                as: 'Client',
                where: { id: req.profile.id },
                required: false,
                attributes: []
            }, {
                model: Profile,
                as: 'Contractor',
                where: { id: req.profile.id },
                required: false,
                attributes: []
            }]
        });

        res.json(contracts);
    } catch (err) {
        next(err);
    }
});

// GET /jobs/unpaid
app.get('/jobs/unpaid', getProfile, async (req, res, next) => {
    try {
        const { Contract, Profile, Job } = req.app.get('models')
        const unpaidJobs = await Job.findAll({
            include: [
                {
                    model: Contract,
                    where: {
                        status: 'in_progress',
                        [Op.or]: [{ ClientId: req.profile.id }, { ContractorId: req.profile.id }]
                    },
                    attributes: []
                }],
            where:
            {
                paid:
                {
                    [Op.not]: true
                }
            },
        });

        res.json(unpaidJobs);
    } catch (err) {
        next(err);
    }
});

// POST /jobs/:job_id/pay - Pay for a job
app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
    const { Contract, Profile, Job } = req.app.get('models')
    const jobId = req.params.job_id;

    try {
        const job = await Job.findByPk(jobId, {
            include: [
                {
                    model: Contract,
                    include: [
                        { model: Profile, as: 'Client' },
                        { model: Profile, as: 'Contractor' }
                    ]
                }
            ]
        });

        // Not Found condition
        if (!job) {
            return res.status(404).json({ message: 'Job not found' });
        }

        const client = job.Contract.Client;
        const contractor = job.Contract.Contractor;

        // Authorization check - Payment should only be authorized by client for the jobs he had requested.
        if (client.id !== req.profile.id) {
            return res.status(400).json({ message: 'User not authorized for this transaction.' });
        }

        // Already paid condition
        if (job.paid) {
            return res.status(400).json({ message: 'Job is already paid' });
        }

        // Balance sufficient check
        if (client.balance < job.price) {
            return res.status(400).json({ message: 'Insufficient balance' });
        }

        // Start a transaction
        const transaction = await sequelize.transaction();

        try {
            // Deduct amount from client's balance and update job payment details
            await client.decrement('balance', { by: job.price, transaction });
            await job.update({ paid: true, paymentDate: new Date() }, { transaction });

            // Add amount to contractor's balance
            await contractor.increment('balance', { by: job.price, transaction });

            // Commit the transaction
            await transaction.commit();

            return res.status(200).json({ message: 'Payment successful' });
        } catch (error) {
            // Rollback the transaction if an error occurs
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Internal server error' });
    }
});

// POST /balances/deposit/:userId - Deposits money into a client's balance
app.post('/balances/deposit/:userId', getProfile, async (req, res) => {
    const userId = req.params.userId;
    const depositAmount = req.body.amount;
    const { Contract, Profile, Job } = req.app.get('models')

    try {
        const client = await Profile.findByPk(userId);

        // User exists check
        if (!client) {
            return res.status(404).json({ message: 'Client not found' });
        }

        // User profile check
        if (client.type !== 'client') {
            return res.status(400).json({ message: 'User is not a client' });
        }

        // Fetch total unpaid jobs price
        const totalUnpaidJobsAmount = await Job.sum('price', {
            where: {
                paid: {
                    [Op.not]: true
                }
            },
            include: {
                model: Contract,
                where: { ClientId: client.id }
            }
        });

        const maxDepositAmount = totalUnpaidJobsAmount * 0.25;

        // Limit check
        if (depositAmount > maxDepositAmount) {
            return res.status(400).json({ message: 'Deposit amount exceeds limit' });
        }

        // Start a transaction
        const transaction = await sequelize.transaction();

        try {
            // Update the client's balance
            await client.increment('balance', { by: depositAmount, transaction });

            // Commit the transaction
            await transaction.commit();

            return res.status(200).json({ message: 'Deposit successful' });
        } catch (error) {
            // Rollback the transaction if an error occurs
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Internal server error' });
    }
});


// GET /admin/best-profession?start=<date>&end=<date>
app.get('/admin/best-profession', async (req, res) => {
    const { start, end } = req.query;
    const { Contract, Profile, Job } = req.app.get('models')

    try {
        const result = await Job.findAll({
            where: {
                paid: {
                    [Op.not]: false
                },
                paymentDate: {
                    [Op.between]: [start, end],
                },
            },
            attributes: ['Contract.Contractor.profession'],
            include: [
                {
                    model: Contract,
                    attributes: ['id'],
                    include: [
                        {
                            model: Profile,
                            as: 'Contractor',
                            attributes: ['profession'],
                        },
                    ],
                },
            ],
            group: ['Contract.Contractor.profession'],
            order: [[sequelize.literal('sum(price)'), 'DESC']],
            limit: 1,
        });

        // Check if profession exists 
        if (result.length > 0) {
            res.json({
                profession: result[0].Contract.Contractor.profession,
            });
        } else {
            res.json({ profession: null });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// GET /admin/best-clients?start=<date>&end=<date>&limit=<integer>
app.get('/admin/best-clients', async (req, res) => {
    const { start, end, limit } = req.query;
    const { Contract, Profile, Job } = req.app.get('models')

    try {
        const bestClients = await Job.findAll({
            where: {
                paid: {
                    [Op.not]: false
                },
                paymentDate: {
                    [Op.between]: [start, end],
                },
            },
            include: [
                {
                    model: Contract,
                    attributes: ['id'],
                    include: [
                        {
                            model: Profile,
                            as: 'Client',
                            where: {
                                type: 'client',
                            },
                        },
                    ],
                },
            ],
            order: [[sequelize.literal('price'), 'DESC']],
            limit: Math.max(parseInt(limit), 2),
        });

        // Prepaing the JSON response which includes only id, fullname and paid amount.
        const response = bestClients.map(client => ({
            id: client.id,
            fullName: `${client.Contract.Client.firstName} ${client.Contract.Client.lastName}`,
            paid: client.price,
        }));

        res.json(response);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = app;
